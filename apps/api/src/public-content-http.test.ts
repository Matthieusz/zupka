// @effect-diagnostics unstableApiUsage:off -- Anonymous real routers with production migrations, files and SQLite.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import { AdminEntry, ManagedImage, PublicContentPage, PublicEntry } from "@zupka/contracts";
import { ConfigProvider, Effect, Layer, Redacted, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { SqlClient } from "effect/sql";
import sharp from "sharp";
import { expect, it } from "vite-plus/test";
import { HashingLive, setOwnerPassword } from "./auth.js";
import { Posts, Projects } from "./content-config.js";
import { acceptContentConfiguration } from "./content-storage.js";
import { DatabaseLive, StorageConfiguration } from "./database.js";
import { EntryRoutes } from "./entry-http.js";
import { ImageRoutes } from "./image-http.js";
import { AuthRoutes } from "./owner-http.js";
import { loadPublicReadOrigins, PublicContentRoutes } from "./public-content-http.js";
import { StorageLive } from "./storage.js";

const origin = "http://localhost:5173";

const portfolio = "https://portfolio.invalid";

async function fixture(publicOrigins = "*") {
  const directory = await mkdtemp(join(tmpdir(), "zupka-public-api-"));

  const config = ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      DATABASE_PATH: join(directory, "content.sqlite"),
      UPLOADS_PATH: join(directory, "images"),
      AUTH_ORIGIN: origin,
      PUBLIC_READ_ORIGINS: publicOrigins,
    }),
  );

  const database = DatabaseLive.pipe(Layer.provide(config));
  await Effect.runPromise(
    setOwnerPassword("create", "owner@example.invalid", Redacted.make("public api password")).pipe(
      Effect.provide(Layer.merge(StorageLive, HashingLive).pipe(Layer.provide(config))),
    ),
  );

  const makeApp = () =>
    HttpRouter.toWebHandler(
      Layer.mergeAll(AuthRoutes, EntryRoutes, ImageRoutes, PublicContentRoutes).pipe(
        Layer.provideMerge(StorageLive),
        Layer.provide(config),
        Layer.provide(NodeHttpServer.layerHttpServices),
      ),
      { disableLogger: true },
    );

  let app = makeApp();
  let cookie = "";

  const anonymous = (path: string, method = "GET", headers: Record<string, string> = {}) =>
    app.handler(new Request(`${origin}${path}`, { method, headers }));

  const request = (path: string, method = "GET", body?: Schema.Json) => {
    const init: RequestInit = {
      method,
      headers: { origin, cookie, "content-type": "application/json", "x-effect-auth-csrf": "1" },
    };

    if (body !== undefined) init.body = JSON.stringify(body);

    return app.handler(new Request(`${origin}${path}`, init));
  };

  try {
    const login = await request("/api/auth/signIn", "POST", {
      payload: { email: "owner@example.invalid", password: "public api password" },
    });

    expect(login.status).toBe(200);
    cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  } catch (error) {
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  const admin = async (path: string, method = "GET", body?: Schema.Json) => {
    const response = await request(path, method, body);
    expect(response.status, await response.clone().text()).toBe(200);

    return Schema.decodeUnknownSync(AdminEntry)(await response.json());
  };

  return {
    anonymous,
    request,
    admin,
    create: (type: string, title: string, fields: Schema.Json = {}) =>
      admin(`/api/admin/entries/${type}`, "POST", { title, fields }),
    transition: (entry: typeof AdminEntry.Type, action: "publish" | "unpublish") =>
      admin(`/api/admin/entries/${entry.typeId}/${entry.id}/${action}`, "POST", {
        revision: entry.revision,
      }),
    save: (entry: typeof AdminEntry.Type, content: typeof AdminEntry.fields.draft.Type) =>
      admin(`/api/admin/entries/${entry.typeId}/${entry.id}`, "PUT", {
        revision: entry.revision,
        content,
      }),
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

      expect(response.status).toBe(200);

      return Schema.decodeUnknownSync(ManagedImage)(await response.json());
    },
    run: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | StorageConfiguration>) =>
      Effect.runPromise(effect.pipe(Effect.provide(database))),
    restart: async () => {
      await app.dispose();
      app = makeApp();
    },
    close: async () => {
      await app.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function page(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");

  return Schema.decodeUnknownSync(PublicContentPage, { onExcessProperty: "error" })(
    await response.json(),
  );
}

async function publicEntry(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");

  return Schema.decodeUnknownSync(PublicEntry, { onExcessProperty: "error" })(
    await response.json(),
  );
}

it("isolates published DTOs through save/republish/unpublish, restart and conditional reads, including image visibility", async () => {
  const test = await fixture();

  try {
    const a = await test.upload();
    const b = await test.upload();

    const created = await test.create("posts", "Public title", {
      body: `![Markdown alt](${a.url})`,
      "cover-image": { imageId: a.id, alt: "Public alt" },
    });

    const url = `/api/content/posts/${created.draft.slug}`;
    expect((await test.anonymous(url)).status).toBe(404);
    expect((await page(await test.anonymous("/api/content/posts"))).total).toBe(0);
    const published = await test.transition(created, "publish");
    const first = await publicEntry(await test.anonymous(url));
    expect(first).toEqual({
      id: created.id,
      typeId: "posts",
      title: "Public title",
      slug: created.draft.slug,
      firstPublishedAt: published.firstPublishedAt,
      publishedAt: published.published?.publishedAt,
      fields: {
        body: `![Markdown alt](${a.url})`,
        "cover-image": { url: a.url, alt: "Public alt" },
      },
    });

    const saved = await test.save(published, {
      ...created.draft,
      title: "Private working title",
      fields: { body: "Private Markdown", "cover-image": { imageId: b.id, alt: "Private alt" } },
    });

    expect(await publicEntry(await test.anonymous(url))).toEqual(first);
    expect(await publicEntry(await test.request(url))).toEqual(first);
    expect((await test.anonymous(a.url)).status).toBe(200);
    expect((await test.anonymous(b.url)).status).toBe(401);
    expect((await page(await test.anonymous("/api/content/posts"))).items).toEqual([first]);
    const republished = await test.transition(saved, "publish");
    const changed = await publicEntry(await test.anonymous(url, "GET", { "if-none-match": "*" }));
    expect(changed.title).toBe("Private working title");
    expect(changed.firstPublishedAt).toBe(first.firstPublishedAt);
    expect(changed.fields["cover-image"]).toEqual({ url: b.url, alt: "Private alt" });
    expect((await test.anonymous(a.url)).status).toBe(401);
    expect((await test.anonymous(b.url)).status).toBe(200);
    await test.restart();
    expect(await publicEntry(await test.anonymous(url))).toEqual(changed);
    const head = await test.anonymous(url, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("cache-control")).toBe("no-store");
    expect(await head.text()).toBe("");
    await test.transition(republished, "unpublish");

    for (const method of ["GET", "HEAD"]) {
      const gone = await test.anonymous(url, method, {
        "if-none-match": "*",
        "if-modified-since": "Wed, 01 Jan 2031 00:00:00 GMT",
      });

      expect(gone.status).toBe(404);
      expect(gone.headers.get("cache-control")).toBe("no-store");
      expect((await test.anonymous(b.url, method)).status).toBe(401);
    }

    expect((await page(await test.anonymous("/api/content/posts"))).items).toEqual([]);
  } finally {
    await test.close();
  }
});

it("orders Posts by published date with first-publication fallback and stable bounded pagination", async () => {
  const test = await fixture();

  try {
    const old = await test.transition(
      await test.create("posts", "Backdated", { "publication-date": "2000-01-01T00:00:00Z" }),
      "publish",
    );

    const fallback = await test.transition(await test.create("posts", "Fallback"), "publish");
    const tied = [];

    for (const title of ["Future A", "Future B", "Future C"])
      tied.push(
        await test.transition(
          await test.create("posts", title, { "publication-date": "2099-01-01T01:00:00+01:00" }),
          "publish",
        ),
      );
    await test.create("posts", "Never public", { "publication-date": "2100-01-01T00:00:00Z" });
    const ids = [...tied.map((entry) => entry.id).sort(), fallback.id, old.id];
    const full = await page(await test.anonymous("/api/content/posts"));
    expect(full).toMatchObject({ total: 5, limit: 20, offset: 0 });
    expect(full.items.map((entry) => entry.id)).toEqual(ids);

    for (const offset of [0, 2, 4, 6]) {
      const part = await page(await test.anonymous(`/api/content/posts?limit=2&offset=${offset}`));
      expect(part).toMatchObject({ total: 5, limit: 2, offset });
      expect(part.items.map((entry) => entry.id)).toEqual(ids.slice(offset, offset + 2));
    }

    const saved = await test.save(old, {
      ...old.draft,
      fields: { "publication-date": "2200-01-01T00:00:00Z" },
    });

    expect(
      (await page(await test.anonymous("/api/content/posts"))).items.map((entry) => entry.id),
    ).toEqual(ids);
    const updated = await test.transition(saved, "publish");
    expect((await page(await test.anonymous("/api/content/posts"))).items[0]?.id).toBe(old.id);
    expect(updated.firstPublishedAt).toBe(old.firstPublishedAt);

    for (const query of [
      "limit=0",
      "limit=101",
      "limit=1.5",
      "limit=no",
      "offset=-1",
      "offset=1000001",
      "offset=NaN",
    ]) {
      const response = await test.anonymous(`/api/content/posts?${query}`);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }

    expect(
      (await page(await test.anonymous("/api/content/posts?limit=100&offset=1000000"))).items,
    ).toEqual([]);
  } finally {
    await test.close();
  }
});

it("delivers custom fields/types and orders non-Posts by first publication, never custom date or republish time", async () => {
  const test = await fixture();

  try {
    await test.run(
      acceptContentConfiguration([
        Posts,
        Projects,
        {
          id: "notes",
          label: "Notes",
          fields: [
            { id: "publication-date", label: "Date", kind: "datetime", required: false },
            { id: "body", label: "Body", kind: "markdown", required: false },
            { id: "score", label: "Score", kind: "number", required: false },
            { id: "ready", label: "Ready", kind: "boolean", required: false },
            { id: "tags", label: "Tags", kind: "text-list", required: false },
            { id: "link", label: "Link", kind: "url", required: false },
            { id: "choice", label: "Choice", kind: "select", choices: ["A", "B"], required: false },
          ],
        },
      ]),
    );
    const image = await test.upload();

    const fields = {
      "publication-date": "2099-01-01T00:00:00.000Z",
      body: `![custom](${image.url})`,
      score: 0,
      ready: false,
      tags: ["a", "b"],
      link: "https://example.invalid/",
      choice: "B",
    };

    const a = await test.transition(await test.create("notes", "Custom", fields), "publish");

    const b = await test.transition(
      await test.create("notes", "Newer", { "publication-date": "1900-01-01T00:00:00Z" }),
      "publish",
    );

    const initial = await page(await test.anonymous("/api/content/notes"));

    const expected = [a, b]
      .sort(
        (x, y) =>
          (y.firstPublishedAt ?? "").localeCompare(x.firstPublishedAt ?? "") ||
          x.id.localeCompare(y.id),
      )
      .map((entry) => entry.id);

    expect(initial.items.map((entry) => entry.id)).toEqual(expected);
    expect((await publicEntry(await test.anonymous("/api/content/notes/custom"))).fields).toEqual(
      fields,
    );
    expect((await test.anonymous(image.url)).status).toBe(200);
    await test.transition(a, "publish");
    expect(
      (await page(await test.anonymous("/api/content/notes"))).items.map((entry) => entry.id),
    ).toEqual(expected);
    await test.transition(b, "unpublish");
    expect((await test.anonymous("/api/content/notes/newer")).status).toBe(404);

    for (const path of [
      "/api/content/missing",
      "/api/content/missing/custom",
      "/api/content/projects/custom",
      "/api/content/notes/absent",
    ])
      expect((await test.anonymous(path)).status).toBe(404);
    expect((await page(await test.anonymous("/api/content/projects"))).total).toBe(0);

    for (const method of ["POST", "PUT", "DELETE"])
      expect((await test.anonymous("/api/content/notes/custom", method)).status).toBe(404);
  } finally {
    await test.close();
  }
});

it("delivers Projects in immutable first-publication order and preserves per-type slug lookup", async () => {
  const test = await fixture();

  try {
    const a = await test.transition(
      await test.create("projects", "Shared slug", {
        technologies: ["Effect"],
        repository: "https://example.invalid/repo",
      }),
      "publish",
    );

    const b = await test.transition(await test.create("projects", "Second project"), "publish");
    const post = await test.transition(await test.create("posts", "Shared slug"), "publish");

    const expected = [a, b]
      .sort(
        (x, y) =>
          (y.firstPublishedAt ?? "").localeCompare(x.firstPublishedAt ?? "") ||
          x.id.localeCompare(y.id),
      )
      .map((entry) => entry.id);

    expect(
      (await page(await test.anonymous("/api/content/projects"))).items.map((entry) => entry.id),
    ).toEqual(expected);
    expect(
      (await publicEntry(await test.anonymous("/api/content/projects/shared-slug"))).fields,
    ).toEqual({ technologies: ["Effect"], repository: "https://example.invalid/repo" });
    expect((await publicEntry(await test.anonymous("/api/content/posts/shared-slug"))).id).toBe(
      post.id,
    );
    await test.transition(a, "publish");
    expect(
      (await page(await test.anonymous("/api/content/projects"))).items.map((entry) => entry.id),
    ).toEqual(expected);
  } finally {
    await test.close();
  }
});

it("never reads drafts for public delivery and projects corrupt publication failures without stored values", async () => {
  const test = await fixture();

  try {
    const created = await test.transition(
      await test.create("posts", "Storage boundary"),
      "publish",
    );

    const url = "/api/content/posts/storage-boundary";
    const before = await publicEntry(await test.anonymous(url));
    await test.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`update content_snapshots set content_json = json_set(content_json, '$.fields.tags', 123) where entry_id = ${created.id} and kind = 'draft'`;
      }),
    );
    expect(await publicEntry(await test.anonymous(url))).toEqual(before);
    expect((await page(await test.anonymous("/api/content/posts"))).items).toEqual([before]);
    await test.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`update content_snapshots set content_json = json_set(content_json, '$.fields.tags', 123, '$.title', 'sensitive stored payload') where entry_id = ${created.id} and kind = 'published'`;
      }),
    );

    for (const path of [url, "/api/content/posts"]) {
      const response = await test.anonymous(path, "GET", { origin: portfolio });
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('{"_tag":"EntryUnavailable"}');
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    }
  } finally {
    await test.close();
  }
});

it("scopes credential-free wildcard CORS to public content, including errors and preflight", async () => {
  const test = await fixture();

  try {
    for (const path of [
      "/api/content/posts",
      "/api/content/posts/absent",
      "/api/content/missing",
      "/api/content/posts?limit=0",
    ]) {
      const response = await test.anonymous(path, "GET", { origin: portfolio });
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
    }

    for (const path of ["/api/content/posts", "/api/content/posts/example"]) {
      const response = await test.anonymous(path, "OPTIONS", {
        origin: portfolio,
        "access-control-request-method": "GET",
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");

      const write = await test.anonymous(path, "OPTIONS", {
        origin: portfolio,
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-effect-auth-csrf",
      });

      expect(write.headers.get("access-control-allow-methods")).not.toContain("POST");
      expect(write.headers.get("access-control-allow-headers")).toBeNull();
    }

    for (const path of [
      "/api/admin/content-types",
      "/api/admin/entries/posts",
      "/api/admin/images",
      "/api/auth/getSession",
    ]) {
      const response = await test.anonymous(path, "GET", { origin: portfolio });
      expect(response.headers.get("access-control-allow-origin")).not.toBe("*");
      expect(response.headers.get("access-control-allow-origin")).not.toBe(portfolio);
    }
  } finally {
    await test.close();
  }
});

it("supports exact public-origin allow lists without extending owner origin trust", async () => {
  const test = await fixture(`${portfolio}, https://second.invalid`);

  try {
    for (const allowed of [portfolio, "https://second.invalid"]) {
      const response = await test.anonymous("/api/content/posts", "GET", { origin: allowed });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(allowed);
      expect(response.headers.get("vary")).toContain("Origin");
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    }

    for (const headers of [{}, { origin: "https://evil.invalid" }, { origin: "null" }]) {
      const response = await test.anonymous("/api/content/posts", "GET", headers);
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }

    expect(
      (await test.anonymous("/api/admin/entries/posts", "GET", { origin: portfolio })).status,
    ).toBe(403);
  } finally {
    await test.close();
  }
});

it("rejects malformed public CORS configuration rather than broadening access", async () => {
  for (const value of [
    "",
    "*,https://example.invalid",
    "https://example.invalid/path",
    "https://*.invalid",
    "null",
    "file:///tmp",
    "https://example.invalid/",
  ]) {
    const result = await Effect.runPromise(
      loadPublicReadOrigins.pipe(
        Effect.result,
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown(
              { PUBLIC_READ_ORIGINS: value },
              { preserveEmptyStrings: true },
            ),
          ),
        ),
      ),
    );

    expect(result._tag, value).toBe("Failure");
  }
});
