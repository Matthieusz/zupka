// @effect-diagnostics unstableApiUsage:off -- Real authenticated HTTP, native image decoding, temporary files and production SQLite migrations.
import { mkdir, mkdtemp, readdir, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import { AdminEntry, ImagePage, ManagedImage } from "@zupka/contracts";
import { InvalidImageReference, MaximumImageBytes } from "@zupka/shared";
import { ConfigProvider, Deferred, Effect, Layer, Redacted, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { SqlClient } from "effect/sql";
import sharp from "sharp";
import { expect, it } from "vite-plus/test";
import { HashingLive, setOwnerPassword } from "./auth.js";
import { Posts, Projects } from "./content-config.js";
import {
  acceptContentConfiguration,
  migrateContentData,
  readDefinitions,
} from "./content-storage.js";
import { DatabaseLive, StorageConfiguration } from "./database.js";
import { EntryRoutes } from "./entry-http.js";
import { ImageRoutes } from "./image-http.js";
import { replaceImageReferences } from "./image-storage.js";
import { AuthRoutes } from "./owner-http.js";
import { StorageLive } from "./storage.js";

const origin = "http://localhost:5173";

const library = "/api/admin/images";

const entries = "/api/admin/entries/posts";

async function encoded(format: "jpeg" | "png" | "webp" | "gif" = "png") {
  return sharp({ create: { width: 2, height: 3, channels: 4, background: "red" } })
    .toFormat(format)
    .toBuffer();
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "zupka-images-"));
  const uploads = join(directory, "images");

  const config = ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      DATABASE_PATH: join(directory, "images.sqlite"),
      UPLOADS_PATH: uploads,
      AUTH_ORIGIN: origin,
    }),
  );

  const database = DatabaseLive.pipe(Layer.provide(config));
  const operator = Layer.merge(StorageLive, HashingLive).pipe(Layer.provide(config));
  await Effect.runPromise(
    setOwnerPassword(
      "create",
      "owner@example.invalid",
      Redacted.make("private image password"),
    ).pipe(Effect.provide(operator)),
  );

  const makeApp = () =>
    HttpRouter.toWebHandler(
      Layer.mergeAll(AuthRoutes, EntryRoutes, ImageRoutes).pipe(
        Layer.provideMerge(StorageLive),
        Layer.provide(config),
        Layer.provide(NodeHttpServer.layerHttpServices),
      ),
      { disableLogger: true },
    );

  let app = makeApp();
  const peer = makeApp();
  let cookie = "";

  const request = (
    path: string,
    method = "GET",
    body?: BodyInit,
    headers?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
    target = app,
  ) => {
    const init: RequestInit & { duplex: "half" } = {
      method,
      duplex: "half",
      headers: {
        origin,
        cookie,
        "x-effect-auth-csrf": "1",
        "content-type": "application/octet-stream",
        ...headers,
      },
    };

    if (body !== undefined) init.body = body;

    if (signal !== undefined) init.signal = signal;

    return target.handler(new Request(`${origin}${path}`, init));
  };

  const json = (path: string, method: string, body: Schema.Json) =>
    request(path, method, JSON.stringify(body), { "content-type": "application/json" });

  const login = await json("/api/auth/signIn", "POST", {
    payload: { email: "owner@example.invalid", password: "private image password" },
  });

  expect(login.status).toBe(200);
  cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");

  return {
    uploads,
    request,
    json,
    peerRequest: (path: string, method = "GET", body?: BodyInit) =>
      request(path, method, body, undefined, undefined, peer),
    run: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | StorageConfiguration>) =>
      Effect.runPromise(effect.pipe(Effect.provide(database))),
    files: async () => {
      try {
        return await readdir(uploads);
      } catch {
        return [];
      }
    },
    restart: async () => {
      await app.dispose();
      app = makeApp();
    },
    close: async () => {
      await peer.dispose();
      await app.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function image(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");

  return Schema.decodeUnknownSync(ManagedImage)(await response.json());
}

async function draft(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);

  return Schema.decodeUnknownSync(AdminEntry)(await response.json());
}

it("verifies all four supported formats, preserves original bytes, and persists a bounded private library across restarts", async () => {
  const test = await fixture();

  try {
    const ids: string[] = [];

    for (const format of ["jpeg", "png", "webp", "gif"] as const) {
      const bytes = await encoded(format);

      const uploaded = await image(
        await test.request(library, "POST", bytes, {
          "content-type": "text/plain",
          "content-disposition": 'form-data; filename="../../forged.svg"',
        }),
      );

      expect(uploaded).toMatchObject({
        mediaType: `image/${format}`,
        bytes: bytes.length,
        width: 2,
        height: 3,
        state: "active",
      });
      ids.push(uploaded.id);
      const served = await test.request(uploaded.url);
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe(`image/${format}`);
      expect(served.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await served.arrayBuffer())).toEqual(bytes);

      const head = await test.request(uploaded.url, "HEAD", undefined, {
        "if-none-match": "*",
        "if-modified-since": "Wed, 01 Jan 2031 00:00:00 GMT",
        range: "bytes=0-1",
      });

      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(bytes.length));
      expect(await head.text()).toBe("");
    }

    await test.restart();
    const response = await test.request(`${library}?limit=2&offset=1`);
    const page = Schema.decodeUnknownSync(ImagePage)(await response.json());
    expect(page).toMatchObject({ total: 4, limit: 2, offset: 1 });
    expect(page.items).toHaveLength(2);
    expect((await test.files()).sort((a, b) => a.localeCompare(b))).toEqual(
      ids.map((id) => `${id}.blob`).sort((a, b) => a.localeCompare(b)),
    );
    expect((await test.request(`${library}?limit=101`)).status).toBe(400);
    expect((await test.request(`${library}?offset=-1`)).status).toBe(400);
  } finally {
    await test.close();
  }
});

it("requires owner authority before uploads, library access, GET/HEAD and conditional requests", async () => {
  const test = await fixture();

  try {
    const bytes = await encoded();
    const uploaded = await image(await test.request(library, "POST", bytes));

    for (const [path, method] of [
      [library, "GET"],
      [library, "POST"],
      [`${library}/${uploaded.id}`, "GET"],
      [`${library}/${uploaded.id}`, "DELETE"],
      [uploaded.url, "GET"],
      [uploaded.url, "HEAD"],
    ]) {
      const response = await test.request(
        path ?? "",
        method,
        method === "POST" ? bytes : undefined,
        { cookie: "", "if-none-match": "*" },
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }

    expect(
      (await test.request(library, "POST", bytes, { origin: "https://evil.invalid" })).status,
    ).toBe(403);
    expect((await test.request(library, "POST", bytes, { "x-effect-auth-csrf": "" })).status).toBe(
      403,
    );
    expect(
      (await test.request(uploaded.url, "HEAD", undefined, { origin: "https://evil.invalid" }))
        .status,
    ).toBe(403);
    expect((await test.request(`/uploads/${uploaded.id}.blob`)).status).toBe(404);
    expect((await test.request("/api/images/not-an-id")).status).toBe(400);
    expect(await test.files()).toHaveLength(1);
  } finally {
    await test.close();
  }
});

it("rejects forged, truncated, unsupported, decompression-heavy and oversized streams without leaving files", async () => {
  const test = await fixture();

  try {
    const png = await encoded();

    const heavy = await sharp({
      create: { width: 4100, height: 4100, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();

    for (const bytes of [
      Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><rect width='5' height='5'/></svg>"),
      Buffer.from("GIF89a forged"),
      Buffer.from("not an image"),
      png.subarray(0, 40),
      Buffer.alloc(0),
      heavy,
    ]) {
      expect(
        (await test.request(library, "POST", bytes, { "content-type": "image/png" })).status,
      ).toBe(400);
    }

    const over = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MaximumImageBytes));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });

    expect((await test.request(library, "POST", over)).status).toBe(413);
    expect(
      (
        await test.request(library, "POST", png, {
          "content-length": String(MaximumImageBytes + 1),
        })
      ).status,
    ).toBe(413);
    expect(await test.files()).toEqual([]);
    const response = await test.request(library);
    expect(Schema.decodeUnknownSync(ImagePage)(await response.json()).total).toBe(0);
    const boundary = Buffer.alloc(MaximumImageBytes);
    boundary.set(png);
    expect((await image(await test.request(library, "POST", boundary))).bytes).toBe(
      MaximumImageBytes,
    );
  } finally {
    await test.close();
  }
});

it("cleans failed uploads and protects generated paths from symlink reads", async () => {
  const test = await fixture();

  try {
    await test.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`create trigger fail_image_insert before insert on content_images begin select raise(abort, 'private failure'); end`;
      }),
    );
    const failed = await test.request(library, "POST", await encoded());
    expect(failed.status).toBe(503);
    expect(await failed.text()).toBe('{"_tag":"ImageUnavailable"}');
    expect(await test.files()).toEqual([]);
    await test.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`drop trigger fail_image_insert`;
      }),
    );
    const uploaded = await image(await test.request(library, "POST", await encoded()));
    const path = join(test.uploads, `${uploaded.id}.blob`);
    await rename(path, `${path}.original`);
    await symlink(`${path}.original`, path);
    expect((await test.request(uploaded.url)).status).toBe(503);
    expect(
      (
        await test.json(entries, "POST", {
          title: "Symlink",
          fields: { "cover-image": { imageId: uploaded.id, alt: "Alt" } },
        })
      ).status,
    ).toBe(400);
    expect((await test.request(`${library}/${uploaded.id}`, "DELETE")).status).toBe(200);
  } finally {
    await test.close();
  }
});

it("validates image/Markdown references and rolls back snapshots, revisions and reference sets on failure", async () => {
  const test = await fixture();

  try {
    const first = await image(await test.request(library, "POST", await encoded()));
    const second = await image(await test.request(library, "POST", await encoded()));
    const unknown = "550e8400-e29b-41d4-a716-446655440000";
    expect(
      (
        await test.json(entries, "POST", {
          title: "Missing",
          fields: { "cover-image": { imageId: unknown, alt: "Missing" } },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await test.json(entries, "POST", {
          title: "Missing Markdown",
          fields: { body: `![missing](/api/images/${unknown})` },
        })
      ).status,
    ).toBe(400);

    const created = await draft(
      await test.json(entries, "POST", {
        title: "Referenced",
        fields: {
          "cover-image": { imageId: first.id, alt: "Original" },
          body: `![one](${first.url})`,
        },
      }),
    );

    const path = `${entries}/${created.id}`;
    await test.restart();
    const deletion = await test.request(`${library}/${first.id}`, "DELETE");
    expect(deletion.status).toBe(409);
    expect(await deletion.json()).toHaveProperty("references", [
      { entryId: created.id, kind: "draft" },
    ]);

    const invalid = await test.json(path, "PUT", {
      revision: 1,
      content: { ...created.draft, fields: { body: `![bad](/api/images/${unknown})` } },
    });

    expect(invalid.status).toBe(400);
    expect(await draft(await test.request(path))).toEqual(created);
    await test.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`create trigger fail_reference before insert on content_image_references begin select raise(abort, 'late reference failure'); end`;
      }),
    );
    expect(
      (
        await test.json(path, "PUT", {
          revision: 1,
          content: { ...created.draft, fields: { body: `![new](${second.url})` } },
        })
      ).status,
    ).toBe(503);
    expect(await draft(await test.request(path))).toEqual(created);
    expect((await test.request(`${library}/${first.id}`, "DELETE")).status).toBe(409);
    await test.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`drop trigger fail_reference`;
      }),
    );
    expect((await test.json(path, "DELETE", { revision: 1 })).status).toBe(200);
    expect((await test.request(`${library}/${first.id}`, "DELETE")).status).toBe(200);
    expect((await test.request(first.url)).status).toBe(404);
  } finally {
    await test.close();
  }
});

it("tracks custom Markdown and published references independently of draft edits and alt text", async () => {
  const test = await fixture();

  try {
    const first = await image(await test.request(library, "POST", await encoded()));
    const second = await image(await test.request(library, "POST", await encoded()));
    await test.run(
      acceptContentConfiguration([
        Posts,
        Projects,
        {
          id: "notes",
          label: "Notes",
          fields: [{ id: "custom-body", label: "Custom body", kind: "markdown", required: false }],
        },
      ]),
    );

    const custom = await draft(
      await test.json("/api/admin/entries/notes", "POST", {
        title: "Custom",
        fields: { "custom-body": `![custom][ref]\n\n[ref]: ${second.url}` },
      }),
    );

    expect((await test.request(`${library}/${second.id}`, "DELETE")).status).toBe(409);

    const created = await draft(
      await test.json(entries, "POST", {
        title: "Published fixture",
        fields: { "cover-image": { imageId: first.id, alt: "Public alt" } },
      }),
    );

    await test.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [type] = (yield* readDefinitions).filter((value) => value.id === "posts");

        if (!type) throw new Error("Missing fixture type");
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`update content_entries set first_published_at = '2025-01-01T00:00:00.000Z', revision = revision + 1 where id = ${created.id}`;
            yield* sql`insert into content_snapshots(entry_id, kind, content_json, published_at) values (${created.id}, 'published', ${JSON.stringify(created.draft)}, '2025-01-01T00:00:00.000Z')`;
            yield* replaceImageReferences(created.id, "published", type, created.draft);
          }),
        );
      }),
    );

    const saved = await draft(
      await test.json(`${entries}/${created.id}`, "PUT", {
        revision: 2,
        content: {
          ...created.draft,
          fields: { "cover-image": { imageId: second.id, alt: "Draft alt" } },
        },
      }),
    );

    expect(saved.published?.content.fields["cover-image"]).toEqual({
      imageId: first.id,
      alt: "Public alt",
    });
    const blocked = await test.request(`${library}/${first.id}`, "DELETE");
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toHaveProperty("references", [
      { entryId: created.id, kind: "published" },
    ]);
    expect((await test.request(first.url, "GET", undefined, { cookie: "" })).status).toBe(200);
    expect((await test.request(`${library}/${second.id}`, "DELETE")).status).toBe(409);
    expect(
      (await test.json(`/api/admin/entries/notes/${custom.id}`, "DELETE", { revision: 1 })).status,
    ).toBe(200);
  } finally {
    await test.close();
  }
});

it("keeps failed deletion tombstones unavailable and non-referenceable, and resumes cleanup after restart", async () => {
  const test = await fixture();

  try {
    const uploaded = await image(await test.request(library, "POST", await encoded()));
    const path = join(test.uploads, `${uploaded.id}.blob`);
    await rename(path, `${path}.original`);
    await mkdir(path);
    expect((await test.request(`${library}/${uploaded.id}`, "DELETE")).status).toBe(503);
    expect((await image(await test.request(`${library}/${uploaded.id}`))).state).toBe("deleting");
    expect((await test.request(uploaded.url)).status).toBe(404);
    expect(
      (
        await test.json(entries, "POST", {
          title: "Reserved",
          fields: { body: `![bad](${uploaded.url})` },
        })
      ).status,
    ).toBe(400);
    await test.restart();
    await rm(path, { recursive: true });
    await rename(`${path}.original`, path);
    await test.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`create trigger fail_image_delete before delete on content_images begin select raise(abort, 'late delete failure'); end`;
      }),
    );
    expect((await test.request(`${library}/${uploaded.id}`, "DELETE")).status).toBe(503);
    expect(await test.files()).toEqual([]);
    expect((await test.request(uploaded.url, "HEAD")).status).toBe(404);
    await test.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`drop trigger fail_image_delete`;
      }),
    );
    expect((await test.request(`${library}/${uploaded.id}`, "DELETE")).status).toBe(200);
  } finally {
    await test.close();
  }
});

it("serializes saving references against deletion on a separate SQLite connection", async () => {
  const test = await fixture();

  try {
    const uploaded = await image(await test.request(library, "POST", await encoded()));
    const created = await draft(await test.json(entries, "POST", { title: "Race" }));
    await test.peerRequest(library);

    const responses = await Promise.all([
      test.json(`${entries}/${created.id}`, "PUT", {
        revision: 1,
        content: { ...created.draft, fields: { body: `![race](${uploaded.url})` } },
      }),
      test.peerRequest(`${library}/${uploaded.id}`, "DELETE"),
    ]);

    expect(responses.filter((value) => value.status === 200)).toHaveLength(1);
    expect(responses.every((value) => [200, 400, 409].includes(value.status))).toBe(true);
    const current = await draft(await test.request(`${entries}/${created.id}`));

    if (responses[0]?.status === 200) {
      expect(current.revision).toBe(2);
      expect((await test.request(uploaded.url)).status).toBe(200);
    } else {
      expect(current.revision).toBe(1);
      expect((await test.request(uploaded.url)).status).toBe(404);
    }
  } finally {
    await test.close();
  }
});

it("rebuilds saved references on startup and validates explicit content migrations transactionally", async () => {
  const test = await fixture();

  try {
    const first = await image(await test.request(library, "POST", await encoded()));
    const second = await image(await test.request(library, "POST", await encoded()));

    const created = await draft(
      await test.json(entries, "POST", {
        title: "Migration",
        fields: { "cover-image": { imageId: first.id, alt: "Before" } },
      }),
    );

    const configuration = await test.run(readDefinitions);
    const header = { version: 1, name: "replace-image", from: configuration, to: configuration };

    const failure = await test.run(
      Effect.flip(
        migrateContentData({
          header,
          transform: (_entry, _kind, content) => ({
            ...content,
            fields: {
              "cover-image": { imageId: "550e8400-e29b-41d4-a716-446655440000", alt: "Missing" },
            },
          }),
        }),
      ),
    );

    expect(failure).toBeInstanceOf(InvalidImageReference);
    expect(await draft(await test.request(`${entries}/${created.id}`))).toEqual(created);
    expect((await test.request(`${library}/${first.id}`, "DELETE")).status).toBe(409);
    await test.run(
      migrateContentData({
        header,
        transform: (_entry, _kind, content) => ({
          ...content,
          fields: { "cover-image": { imageId: second.id, alt: "After" } },
        }),
      }),
    );
    expect((await test.request(`${library}/${first.id}`, "DELETE")).status).toBe(200);
    await test.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`delete from content_image_references`;
      }),
    );
    await test.restart();
    expect((await test.request(`${library}/${second.id}`, "DELETE")).status).toBe(409);
    expect((await draft(await test.request(`${entries}/${created.id}`))).revision).toBe(2);
  } finally {
    await test.close();
  }
});

it("cancels incomplete uploads without files and bounds simultaneous body readers before decoding", async () => {
  const test = await fixture();
  const controllers = [new AbortController(), new AbortController()];
  const waiting = [Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>()];
  const stalled = Deferred.makeUnsafe<void>();
  const requests: Promise<Response>[] = [];

  try {
    for (const [index, controller] of controllers.entries()) {
      const stream = new ReadableStream<Uint8Array>(
        {
          async pull(target) {
            target.enqueue(new Uint8Array([137, 80, 78, 71]));
            const gate = waiting[index];

            if (gate) await Effect.runPromise(Deferred.succeed(gate, undefined));
            await Effect.runPromise(Deferred.await(stalled));
          },
        },
        { highWaterMark: 0 },
      );

      requests.push(test.request(library, "POST", stream, undefined, controller.signal));
    }

    await Promise.all(waiting.map((value) => Effect.runPromise(Deferred.await(value))));
    expect((await test.request(library, "POST", await encoded())).status).toBe(429);

    for (const controller of controllers) controller.abort();
    await Effect.runPromise(Deferred.succeed(stalled, undefined));
    await Promise.allSettled(requests);
    expect(await test.files()).toEqual([]);
    await image(await test.request(library, "POST", await encoded()));
  } finally {
    for (const controller of controllers) controller.abort();
    await Effect.runPromise(Deferred.succeed(stalled, undefined));
    await Promise.allSettled(requests);
    await test.close();
  }
});
