// @effect-diagnostics unstableApiUsage:off -- Real authenticated routers, native images, files and production SQLite transactions.
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import { AdminEntry, EntryPage, ManagedImage } from "@zupka/contracts";
import { ConfigProvider, Effect, Layer, Redacted, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { SqlClient } from "effect/sql";
import sharp from "sharp";
import { expect, it } from "vite-plus/test";
import { HashingLive, setOwnerPassword } from "./auth.js";
import { Posts, Projects } from "./content-config.js";
import {
  acceptContentConfiguration,
  ContentConfigurationConflict,
  readDefinitions,
} from "./content-storage.js";
import { DatabaseLive, StorageConfiguration } from "./database.js";
import { EntryRoutes } from "./entry-http.js";
import { ImageRoutes } from "./image-http.js";
import { AuthRoutes } from "./owner-http.js";
import { StorageLive } from "./storage.js";

const origin = "http://localhost:5173";

const base = "/api/admin/entries/posts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "zupka-publication-"));
  const uploads = join(directory, "images");

  const config = ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      DATABASE_PATH: join(directory, "content.sqlite"),
      UPLOADS_PATH: uploads,
      AUTH_ORIGIN: origin,
    }),
  );

  const database = DatabaseLive.pipe(Layer.provide(config));
  const operator = Layer.merge(StorageLive, HashingLive).pipe(Layer.provide(config));
  await Effect.runPromise(
    setOwnerPassword("create", "owner@example.invalid", Redacted.make("publication password")).pipe(
      Effect.provide(operator),
    ),
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
    body?: Schema.Json,
    headers?: Readonly<Record<string, string>>,
    target = app,
  ) => {
    const init: RequestInit = {
      method,
      headers: {
        origin,
        cookie,
        "content-type": "application/json",
        "x-effect-auth-csrf": "1",
        ...headers,
      },
    };

    if (body !== undefined) init.body = JSON.stringify(body);

    return target.handler(new Request(`${origin}${path}`, init));
  };

  try {
    const login = await request("/api/auth/signIn", "POST", {
      payload: { email: "owner@example.invalid", password: "publication password" },
    });

    expect(login.status).toBe(200);
    cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  } catch (error) {
    await peer.dispose();
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    uploads,
    request,
    peerRequest: (path: string, method = "GET", body?: Schema.Json) =>
      request(path, method, body, undefined, peer),
    anonymous: (path: string, method = "GET", headers?: Readonly<Record<string, string>>) =>
      request(path, method, undefined, { cookie: "", ...headers }),
    upload: async () => {
      const bytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: "red" } })
        .png()
        .toBuffer();

      const response = await app.handler(
        new Request(`${origin}/api/admin/images`, {
          method: "POST",
          headers: {
            origin,
            cookie,
            "x-effect-auth-csrf": "1",
            "content-type": "application/octet-stream",
          },
          body: bytes,
        }),
      );

      expect(response.status, await response.clone().text()).toBe(200);

      return Schema.decodeUnknownSync(ManagedImage)(await response.json());
    },
    run: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | StorageConfiguration>) =>
      Effect.runPromise(effect.pipe(Effect.provide(database))),
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

async function entry(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");

  return Schema.decodeUnknownSync(AdminEntry)(await response.json());
}

const rawState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    entries: yield* sql`select * from content_entries order by id`,
    snapshots: yield* sql`select * from content_snapshots order by entry_id, kind`,
    references:
      yield* sql`select * from content_image_references order by entry_id, kind, image_id`,
  };
});

it("publishes only saved drafts, preserves history/slug locks, and derives states through edit/republish/unpublish", async () => {
  const test = await fixture();

  try {
    const created = await entry(
      await test.request(base, "POST", { title: "Original", fields: { summary: "Public" } }),
    );

    const path = `${base}/${created.id}`;

    const published = await entry(
      await test.request(`${path}/publish`, "POST", {
        revision: 1,
        content: { title: "Unsaved input is not a draft" },
      }),
    );

    expect(published).toMatchObject({
      revision: 2,
      state: "published",
      draft: created.draft,
      published: { content: created.draft },
    });
    expect(published.firstPublishedAt).toBe(published.published?.publishedAt);

    const edited = await entry(
      await test.request(path, "PUT", {
        revision: 2,
        content: { ...created.draft, title: "Working title", fields: { summary: "Draft" } },
      }),
    );

    expect(edited).toMatchObject({
      revision: 3,
      state: "published-with-draft-changes",
      published: published.published,
    });
    expect((await test.request(`${path}/publish`, "POST", { revision: 2 })).status).toBe(409);

    const reverted = await entry(
      await test.request(path, "PUT", { revision: 3, content: created.draft }),
    );

    expect(reverted.state).toBe("published");

    const changed = await entry(
      await test.request(path, "PUT", { revision: reverted.revision, content: edited.draft }),
    );

    const republished = await entry(
      await test.request(`${path}/publish`, "POST", { revision: changed.revision }),
    );

    expect(republished).toMatchObject({
      state: "published",
      firstPublishedAt: published.firstPublishedAt,
      published: { content: edited.draft },
    });
    expect((await test.request(path, "DELETE", { revision: republished.revision })).status).toBe(
      409,
    );

    const unpublished = await entry(
      await test.request(`${path}/unpublish`, "POST", { revision: republished.revision }),
    );

    expect(unpublished).toMatchObject({
      state: "unpublished",
      published: null,
      draft: edited.draft,
      firstPublishedAt: published.firstPublishedAt,
    });
    expect(
      (
        await test.request(path, "PUT", {
          revision: unpublished.revision,
          content: { ...edited.draft, slug: "new-slug" },
        })
      ).status,
    ).toBe(409);
    await test.restart();

    const again = await entry(
      await test.request(`${path}/publish`, "POST", { revision: unpublished.revision }),
    );

    expect(again.firstPublishedAt).toBe(published.firstPublishedAt);

    const removed = await entry(
      await test.request(`${path}/unpublish`, "POST", { revision: again.revision }),
    );

    const noOp = await entry(
      await test.request(`${path}/unpublish`, "POST", { revision: removed.revision }),
    );

    expect(noOp.revision).toBe(removed.revision + 1);
    expect(noOp.draft).toEqual(removed.draft);
    expect((await test.request(path, "DELETE", { revision: noOp.revision })).status).toBe(200);
  } finally {
    await test.close();
  }
});

it("derives shared image visibility from current publications, not draft edits or historical publication", async () => {
  const test = await fixture();

  try {
    const a = await test.upload();
    const b = await test.upload();
    const c = await test.upload();

    const first = await entry(
      await test.request(base, "POST", {
        title: "First",
        fields: { "cover-image": { imageId: a.id, alt: "Public alt" }, body: `![body](${b.url})` },
      }),
    );

    const firstPath = `${base}/${first.id}`;
    expect((await test.anonymous(a.url)).status).toBe(401);

    const published = await entry(
      await test.request(`${firstPath}/publish`, "POST", { revision: 1 }),
    );

    for (const image of [a, b]) {
      const response = await test.anonymous(image.url, "GET", {
        origin: "https://portfolio.invalid",
        "if-none-match": "*",
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();

      const head = await test.anonymous(image.url, "HEAD", {
        "if-modified-since": "Wed, 01 Jan 2031 00:00:00 GMT",
        range: "bytes=0-1",
      });

      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(image.bytes));
      expect(await head.text()).toBe("");
    }

    expect((await test.anonymous(firstPath)).status).toBe(401);
    expect((await test.anonymous(`/api/admin/images/${a.id}`)).status).toBe(401);

    const edited = await entry(
      await test.request(firstPath, "PUT", {
        revision: published.revision,
        content: { ...first.draft, fields: { "cover-image": { imageId: c.id, alt: "Draft alt" } } },
      }),
    );

    expect(edited.published?.content.fields["cover-image"]).toEqual({
      imageId: a.id,
      alt: "Public alt",
    });
    expect((await test.anonymous(a.url)).status).toBe(200);
    expect((await test.anonymous(b.url)).status).toBe(200);
    expect((await test.anonymous(c.url)).status).toBe(401);

    const second = await entry(
      await test.request(base, "POST", {
        title: "Second",
        fields: { body: `![shared](${a.url})` },
      }),
    );

    const secondPath = `${base}/${second.id}`;

    const secondPublication = await entry(
      await test.request(`${secondPath}/publish`, "POST", { revision: 1 }),
    );

    const republished = await entry(
      await test.request(`${firstPath}/publish`, "POST", { revision: edited.revision }),
    );

    expect((await test.anonymous(a.url)).status).toBe(200);
    expect((await test.anonymous(b.url)).status).toBe(401);
    expect((await test.anonymous(c.url)).status).toBe(200);
    expect((await test.request(`/api/admin/images/${b.id}`, "DELETE")).status).toBe(200);

    const secondUnpublished = await entry(
      await test.request(`${secondPath}/unpublish`, "POST", {
        revision: secondPublication.revision,
      }),
    );

    expect((await test.anonymous(a.url, "HEAD", { "if-none-match": "*" })).status).toBe(401);
    expect((await test.request(a.url)).status).toBe(200);
    expect((await test.request(`/api/admin/images/${a.id}`, "DELETE")).status).toBe(409);

    const empty = await entry(
      await test.request(secondPath, "PUT", {
        revision: secondUnpublished.revision,
        content: { ...second.draft, fields: {} },
      }),
    );

    expect(empty.published).toBeNull();
    expect((await test.request(`/api/admin/images/${a.id}`, "DELETE")).status).toBe(200);

    const firstUnpublished = await entry(
      await test.request(`${firstPath}/unpublish`, "POST", { revision: republished.revision }),
    );

    expect(firstUnpublished.draft).toEqual(edited.draft);
    expect((await test.anonymous(c.url)).status).toBe(401);
    expect((await test.request(`/api/admin/images/${c.id}`, "DELETE")).status).toBe(409);
  } finally {
    await test.close();
  }
});

it("rejects incomplete required custom fields at publish while validating custom Markdown references", async () => {
  const test = await fixture();

  try {
    const image = await test.upload();
    await test.run(
      acceptContentConfiguration([
        Posts,
        Projects,
        {
          id: "notes",
          label: "Notes",
          fields: [
            { id: "venue", label: "Venue", kind: "text", required: true },
            { id: "custom-body", label: "Custom Markdown", kind: "markdown", required: false },
          ],
        },
      ]),
    );

    const created = await entry(
      await test.request("/api/admin/entries/notes", "POST", {
        title: "Incomplete",
        fields: { "custom-body": `![custom][ref]\n\n[ref]: ${image.url}` },
      }),
    );

    const path = `/api/admin/entries/notes/${created.id}`;
    expect((await test.request(`${path}/publish`, "POST", { revision: 1 })).status).toBe(400);
    expect(await entry(await test.request(path))).toEqual(created);
    expect((await test.anonymous(image.url)).status).toBe(401);

    const saved = await entry(
      await test.request(path, "PUT", {
        revision: 1,
        content: { ...created.draft, fields: { ...created.draft.fields, venue: "Conference" } },
      }),
    );

    const published = await entry(
      await test.request(`${path}/publish`, "POST", { revision: saved.revision }),
    );

    expect(published.state).toBe("published");
    expect((await test.anonymous(image.url)).status).toBe(200);
    const response = await test.request("/api/admin/entries/notes?state=published");
    expect(
      Schema.decodeUnknownSync(EntryPage)(await response.json()).items.map((value) => value.id),
    ).toEqual([created.id]);
  } finally {
    await test.close();
  }
});

it("revalidates saved image files at publication and leaves the previous public version intact on failure", async () => {
  const test = await fixture();

  try {
    const a = await test.upload();
    const b = await test.upload();

    const created = await entry(
      await test.request(base, "POST", {
        title: "Files",
        fields: { "cover-image": { imageId: a.id, alt: "A" } },
      }),
    );

    const path = `${base}/${created.id}`;
    const file = join(test.uploads, `${a.id}.blob`);
    await rename(file, `${file}.backup`);
    expect((await test.request(`${path}/publish`, "POST", { revision: 1 })).status).toBe(400);
    expect(await entry(await test.request(path))).toEqual(created);
    await rename(`${file}.backup`, file);
    const published = await entry(await test.request(`${path}/publish`, "POST", { revision: 1 }));

    const saved = await entry(
      await test.request(path, "PUT", {
        revision: published.revision,
        content: { ...created.draft, fields: { "cover-image": { imageId: b.id, alt: "B" } } },
      }),
    );

    const missing = join(test.uploads, `${b.id}.blob`);
    await rename(missing, `${missing}.backup`);
    expect(
      (await test.request(`${path}/publish`, "POST", { revision: saved.revision })).status,
    ).toBe(400);
    expect(await entry(await test.request(path))).toEqual(saved);
    expect((await test.anonymous(a.url)).status).toBe(200);
    expect((await test.anonymous(b.url)).status).toBe(401);
    await rename(`${missing}.backup`, missing);
  } finally {
    await test.close();
  }
});

it("rolls back first publication, republishing and unpublishing after late reference/snapshot failures", async () => {
  const test = await fixture();

  try {
    const a = await test.upload();
    const b = await test.upload();

    const created = await entry(
      await test.request(base, "POST", { title: "Rollback", fields: { body: `![a](${a.url})` } }),
    );

    const path = `${base}/${created.id}`;
    const published = await entry(await test.request(`${path}/publish`, "POST", { revision: 1 }));

    const saved = await entry(
      await test.request(path, "PUT", {
        revision: published.revision,
        content: { ...created.draft, fields: { body: `![b](${b.url})` } },
      }),
    );

    await test.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`create trigger fail_public_references before insert on content_image_references when new.kind = 'published' begin select raise(abort, 'private late failure'); end`;
      }),
    );
    const before = await test.run(rawState);
    const failed = await test.request(`${path}/publish`, "POST", { revision: saved.revision });
    expect(failed.status).toBe(503);
    expect(await failed.text()).toBe('{"_tag":"EntryUnavailable"}');
    expect(await test.run(rawState)).toEqual(before);
    expect((await test.anonymous(a.url)).status).toBe(200);
    expect((await test.anonymous(b.url)).status).toBe(401);

    const fresh = await entry(
      await test.request(base, "POST", {
        title: "Never published",
        fields: { body: `![b](${b.url})` },
      }),
    );

    expect(
      (await test.request(`${base}/${fresh.id}/publish`, "POST", { revision: 1 })).status,
    ).toBe(503);
    expect(await entry(await test.request(`${base}/${fresh.id}`))).toEqual(fresh);
    await entry(
      await test.request(`${base}/${fresh.id}`, "PUT", {
        revision: 1,
        content: { ...fresh.draft, slug: "still-editable" },
      }),
    );
    await test.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`drop trigger fail_public_references`;
        yield* sql`create trigger fail_unpublish before delete on content_snapshots when old.kind = 'published' begin select raise(abort, 'private unpublish failure'); end`;
      }),
    );
    const unpublishBefore = await test.run(rawState);
    expect(
      (await test.request(`${path}/unpublish`, "POST", { revision: saved.revision })).status,
    ).toBe(503);
    expect(await test.run(rawState)).toEqual(unpublishBefore);
    expect((await test.anonymous(a.url)).status).toBe(200);
    expect(await entry(await test.request(path))).toEqual(saved);
  } finally {
    await test.close();
  }
});

it("requires owner/Origin/CSRF and bounded revision inputs on every publication transition", async () => {
  const test = await fixture();

  try {
    const created = await entry(await test.request(base, "POST", { title: "Protected" }));
    const path = `${base}/${created.id}`;

    for (const action of ["publish", "unpublish"]) {
      expect(
        (await test.request(`${path}/${action}`, "POST", { revision: 1 }, { cookie: "" })).status,
      ).toBe(401);
      expect(
        (
          await test.request(
            `${path}/${action}`,
            "POST",
            { revision: 1 },
            { origin: "https://evil.invalid" },
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await test.request(
            `${path}/${action}`,
            "POST",
            { revision: 1 },
            { "x-effect-auth-csrf": "" },
          )
        ).status,
      ).toBe(403);

      for (const body of [{}, { revision: 0 }, { revision: 1.5 }, { revision: "1" }])
        expect((await test.request(`${path}/${action}`, "POST", body)).status).toBe(400);
      expect(
        (
          await test.request(`/api/admin/entries/projects/${created.id}/${action}`, "POST", {
            revision: 1,
          })
        ).status,
      ).toBe(404);
    }

    expect(await entry(await test.request(path))).toEqual(created);
    expect((await test.anonymous(`${path}/publish`, "GET")).status).toBe(404);
  } finally {
    await test.close();
  }
});

it("guards competing save/publish/unpublish commands with one shared revision across connections", async () => {
  const test = await fixture();

  try {
    const image = await test.upload();

    const created = await entry(
      await test.request(base, "POST", {
        title: "Race",
        fields: { body: `![image](${image.url})` },
      }),
    );

    const path = `${base}/${created.id}`;
    await test.peerRequest(path);

    const first = await Promise.all([
      test.request(path, "PUT", {
        revision: 1,
        content: { ...created.draft, title: "Saved concurrently" },
      }),
      test.peerRequest(`${path}/publish`, "POST", { revision: 1 }),
    ]);

    expect(first.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 409]);
    const current = await entry(await test.request(path));
    expect(current.revision).toBe(2);
    expect((await test.anonymous(image.url)).status).toBe(current.published ? 200 : 401);

    const second = await Promise.all([
      test.request(`${path}/publish`, "POST", { revision: 2 }),
      test.peerRequest(`${path}/unpublish`, "POST", { revision: 2 }),
    ]);

    expect(second.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 409]);
    const after = await entry(await test.request(path));
    expect(after.revision).toBe(3);
    expect((await test.anonymous(image.url)).status).toBe(after.published ? 200 : 401);
    expect((await test.request(path, "PUT", { revision: 2, content: created.draft })).status).toBe(
      409,
    );
  } finally {
    await test.close();
  }
});

it("rejects incompatible configuration adoption racing with publication without changing accepted definitions", async () => {
  const test = await fixture();

  try {
    const created = await entry(await test.request(base, "POST", { title: "Configuration race" }));
    const before = await test.run(readDefinitions);

    const [publication, adoption] = await Promise.all([
      test.request(`${base}/${created.id}/publish`, "POST", { revision: 1 }),
      test.run(
        Effect.flip(
          acceptContentConfiguration([
            { ...Posts, fields: Posts.fields.map((field) => ({ ...field, required: true })) },
            Projects,
          ]),
        ),
      ),
    ]);

    expect(publication.status).toBe(200);
    expect(adoption).toBeInstanceOf(ContentConfigurationConflict);
    expect(await test.run(readDefinitions)).toEqual(before);
    expect((await entry(await test.request(`${base}/${created.id}`))).state).toBe("published");
  } finally {
    await test.close();
  }
});

it("serializes entry/image deletion against publication without broken committed references", async () => {
  const test = await fixture();

  try {
    const image = await test.upload();

    const created = await entry(
      await test.request(base, "POST", {
        title: "Delete race",
        fields: { body: `![image](${image.url})` },
      }),
    );

    const path = `${base}/${created.id}`;
    await test.peerRequest(path);

    const imageRace = await Promise.all([
      test.request(`${path}/publish`, "POST", { revision: 1 }),
      test.peerRequest(`/api/admin/images/${image.id}`, "DELETE"),
    ]);

    expect(imageRace.map((response) => response.status)).toEqual([200, 409]);

    const unpublished = await entry(
      await test.request(`${path}/unpublish`, "POST", { revision: 2 }),
    );

    const entryRace = await Promise.all([
      test.request(`${path}/publish`, "POST", { revision: unpublished.revision }),
      test.peerRequest(path, "DELETE", { revision: unpublished.revision }),
    ]);

    expect(entryRace.filter((response) => response.status === 200)).toHaveLength(1);
    expect(entryRace.every((response) => [200, 404, 409].includes(response.status))).toBe(true);

    if (entryRace[0]?.status === 200) {
      expect((await test.anonymous(image.url)).status).toBe(200);
      expect((await test.request(`/api/admin/images/${image.id}`, "DELETE")).status).toBe(409);
    } else {
      expect((await test.anonymous(image.url)).status).toBe(401);
      expect((await test.request(`/api/admin/images/${image.id}`, "DELETE")).status).toBe(200);
    }
  } finally {
    await test.close();
  }
});
