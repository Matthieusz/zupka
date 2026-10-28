// @effect-diagnostics unstableApiUsage:off -- Real temporary SQLite databases and the production migration/router path.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import { AdminEntry, EntryPage } from "@zupka/contracts";
import { ConfigProvider, Effect, Layer, Redacted, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { SqlClient } from "effect/sql";
import { expect, it } from "vite-plus/test";
import { HashingLive, setOwnerPassword } from "./auth.js";
import { Posts, Projects, TalksExample } from "./content-config.js";
import { acceptContentConfiguration } from "./content-storage.js";
import { DatabaseLive, StorageConfiguration } from "./database.js";
import { EntryRoutes } from "./entry-http.js";
import { AuthRoutes } from "./owner-http.js";
import { StorageLive } from "./storage.js";

const origin = "http://localhost:5173";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "zupka-entries-"));

  const config = ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      DATABASE_PATH: join(directory, "content.sqlite"),
      UPLOADS_PATH: join(directory, "images"),
      AUTH_ORIGIN: origin,
    }),
  );

  const operator = Layer.merge(StorageLive, HashingLive).pipe(Layer.provide(config));
  const database = DatabaseLive.pipe(Layer.provide(config));

  const makeApp = () =>
    HttpRouter.toWebHandler(
      Layer.merge(AuthRoutes, EntryRoutes).pipe(
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
        "content-type": "application/json",
        "x-effect-auth-csrf": "1",
        cookie,
        ...headers,
      },
    };

    if (body !== undefined) init.body = JSON.stringify(body);

    return target.handler(new Request(`${origin}${path}`, init));
  };

  try {
    await Effect.runPromise(
      setOwnerPassword(
        "create",
        "owner@example.invalid",
        Redacted.make("draft management password"),
      ).pipe(Effect.provide(operator)),
    );

    const login = await request("/api/auth/signIn", "POST", {
      payload: { email: "owner@example.invalid", password: "draft management password" },
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
    request,
    peerRequest: (path: string, method = "GET", body?: Schema.Json) =>
      request(path, method, body, undefined, peer),
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

const base = "/api/admin/entries/posts";

async function entry(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");

  return Schema.decodeUnknownSync(AdminEntry)(await response.json());
}

async function page(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);

  return Schema.decodeUnknownSync(EntryPage)(await response.json());
}

it("creates, retrieves, saves and permanently deletes authenticated drafts across router restarts", async () => {
  const test = await fixture();

  try {
    const created = await entry(
      await test.request(base, "POST", {
        title: "Héllo World",
        fields: { summary: "First", tags: ["one"] },
      }),
    );

    expect(created).toMatchObject({
      revision: 1,
      state: "unpublished",
      published: null,
      firstPublishedAt: null,
      draft: { slug: "hello-world" },
    });
    await test.restart();
    expect(await entry(await test.request(`${base}/${created.id}`))).toEqual(created);

    const saved = await entry(
      await test.request(`${base}/${created.id}`, "PUT", {
        revision: 1,
        content: { title: "Renamed", slug: "editable", fields: { body: "# Markdown" } },
      }),
    );

    expect(saved).toMatchObject({
      revision: 2,
      id: created.id,
      createdAt: created.createdAt,
      draft: { title: "Renamed", slug: "editable", fields: { body: "# Markdown" } },
    });

    const renamed = await entry(
      await test.request(`${base}/${created.id}`, "PUT", {
        revision: 2,
        content: { ...saved.draft, title: "Title only" },
      }),
    );

    expect(renamed.draft.slug).toBe("editable");
    expect((await test.request(`${base}/${created.id}`, "DELETE", { revision: 2 })).status).toBe(
      409,
    );
    expect((await test.request(`${base}/${created.id}`, "DELETE", { revision: 3 })).status).toBe(
      200,
    );
    expect((await test.request(`${base}/${created.id}`)).status).toBe(404);
    expect((await page(await test.request(base))).total).toBe(0);
  } finally {
    await test.close();
  }
});

it("rejects invalid values, identity edits, duplicate slugs, bad pagination and unknown type/entry pairs", async () => {
  const test = await fixture();

  try {
    for (const body of [
      { title: " " },
      { title: "Valid", slug: "Bad Slug" },
      { title: "Valid", fields: { tags: "not a list" } },
      { title: "Valid", fields: { unexpected: true } },
      { title: "Valid", fields: { "live-site": "javascript:alert(1)" } },
    ])
      expect((await test.request(base, "POST", body)).status).toBe(400);
    const created = await entry(await test.request(base, "POST", { title: "Unique" }));
    expect((await test.request(base, "POST", { title: "Unique" })).status).toBe(409);
    await entry(await test.request("/api/admin/entries/projects", "POST", { title: "Unique" }));
    const other = await entry(await test.request(base, "POST", { title: "Other" }));
    expect(
      (await test.request(`${base}/${other.id}`, "PUT", { revision: 1, content: created.draft }))
        .status,
    ).toBe(409);
    expect((await entry(await test.request(`${base}/${other.id}`))).revision).toBe(1);
    expect((await test.request(`/api/admin/entries/projects/${created.id}`)).status).toBe(404);
    expect((await test.request("/api/admin/entries/unknown")).status).toBe(404);
    expect(
      (
        await test.request(`${base}/${created.id}`, "PUT", {
          revision: 1,
          content: { title: " ", slug: "unique", fields: {} },
        })
      ).status,
    ).toBe(400);
    expect(
      (await test.request(`${base}/${created.id}`, "PUT", { content: created.draft })).status,
    ).toBe(400);

    for (const query of [
      "limit=0",
      "limit=101",
      "limit=1.5",
      "offset=-1",
      "offset=1000001",
      "state=draft",
      "limit=1x",
      `search=${"x".repeat(201)}`,
    ]) {
      expect((await test.request(`${base}?${query}`)).status).toBe(400);
    }
  } finally {
    await test.close();
  }
});

it("uses accepted custom definitions, creation-only defaults and normalized field schemas", async () => {
  const test = await fixture();

  try {
    // Initialize the router before adopting the fixture's custom code configuration.
    await test.request(base);
    await test.run(acceptContentConfiguration([Posts, Projects, TalksExample]));
    const types = await test.request("/api/admin/content-types");
    expect(types.status).toBe(200);
    expect(await types.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "talks" })]),
    );

    const created = await entry(
      await test.request("/api/admin/entries/talks", "POST", {
        title: "Incomplete required fields",
      }),
    );

    expect(created.draft.fields).toEqual({ duration: 30, recorded: false, format: "Meetup" });

    const saved = await entry(
      await test.request(`/api/admin/entries/talks/${created.id}`, "PUT", {
        revision: 1,
        content: { ...created.draft, fields: {} },
      }),
    );

    expect(saved.draft.fields).toEqual({});

    const post = await entry(
      await test.request(base, "POST", {
        title: "Date",
        fields: { "publication-date": "2025-01-01T10:00:00+02:00" },
      }),
    );

    expect(post.draft.fields["publication-date"]).toBe("2025-01-01T08:00:00.000Z");
  } finally {
    await test.close();
  }
});

it("authenticates all reads/writes and rejects foreign Origin or missing CSRF without changing drafts", async () => {
  const test = await fixture();

  try {
    const created = await entry(await test.request(base, "POST", { title: "Private" }));

    for (const [path, method, body] of [
      [base, "GET", undefined],
      ["/api/admin/content-types", "GET", undefined],
      [`${base}/${created.id}`, "GET", undefined],
      [base, "POST", { title: "Forbidden" }],
      [`${base}/${created.id}`, "PUT", { revision: 1, content: created.draft }],
      [`${base}/${created.id}`, "DELETE", { revision: 1 }],
    ] as const)
      expect((await test.request(path, method, body, { cookie: "" })).status).toBe(401);
    expect(
      (await test.request(base, "POST", { title: "Foreign" }, { origin: "https://evil.invalid" }))
        .status,
    ).toBe(403);
    expect(
      (await test.request(base, "POST", { title: "No csrf" }, { "x-effect-auth-csrf": "" })).status,
    ).toBe(403);
    expect(
      (await test.request(base, "GET", undefined, { origin: "https://evil.invalid" })).status,
    ).toBe(403);
    expect((await page(await test.request(base))).total).toBe(1);
  } finally {
    await test.close();
  }
});

it("rejects stale saves and overlapping saves/deletions rather than silently overwriting", async () => {
  const test = await fixture();

  try {
    const created = await entry(await test.request(base, "POST", { title: "Concurrent" }));
    const path = `${base}/${created.id}`;
    await test.peerRequest(path);

    const results = await Promise.all([
      test.request(path, "PUT", { revision: 1, content: { ...created.draft, title: "First" } }),
      test.peerRequest(path, "PUT", {
        revision: 1,
        content: { ...created.draft, title: "Second" },
      }),
    ]);

    expect(results.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 409]);
    const winner = await entry(await test.request(path));
    expect(winner.revision).toBe(2);
    expect((await test.request(path, "PUT", { revision: 1, content: created.draft })).status).toBe(
      409,
    );
    expect(await entry(await test.request(path))).toEqual(winner);

    const race = await Promise.all([
      test.request(path, "PUT", { revision: 2, content: { ...winner.draft, title: "Newer" } }),
      test.peerRequest(path, "DELETE", { revision: 2 }),
    ]);

    expect(race.filter((response) => response.status === 200)).toHaveLength(1);
    expect(race.every((response) => [200, 404, 409].includes(response.status))).toBe(true);
  } finally {
    await test.close();
  }
});

it("rolls back draft metadata when a late snapshot write fails, without leaking SQL or content", async () => {
  const test = await fixture();

  try {
    const created = await entry(await test.request(base, "POST", { title: "Before failure" }));
    await test.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`create trigger reject_draft_save before update on content_snapshots
        begin select raise(abort, 'private infrastructure detail'); end`;
      }),
    );

    const response = await test.request(`${base}/${created.id}`, "PUT", {
      revision: 1,
      content: { title: "Sensitive authored title", slug: "new-slug", fields: {} },
    });

    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"_tag":"EntryUnavailable"}');
    expect(await entry(await test.request(`${base}/${created.id}`))).toEqual(created);
    expect((await page(await test.request(base))).total).toBe(1);
  } finally {
    await test.close();
  }
});

it("serializes duplicate creation attempts across separate SQLite connections", async () => {
  const test = await fixture();

  try {
    await test.request(base);
    await test.peerRequest(base);

    const responses = await Promise.all([
      test.request(base, "POST", { title: "Same suggestion" }),
      test.peerRequest(base, "POST", { title: "Same suggestion" }),
    ]);

    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 409]);
    expect((await page(await test.request(base))).total).toBe(1);
  } finally {
    await test.close();
  }
});

it("isolates published snapshots, locks historical slugs, and filters actual publication states with literal title search", async () => {
  const test = await fixture();

  try {
    const unchanged = await entry(
      await test.request(base, "POST", {
        title: "Same %_",
        fields: { tags: ["a", "b"], summary: "Text" },
      }),
    );

    const changing = await entry(await test.request(base, "POST", { title: "Change %_" }));
    await entry(await test.request(base, "POST", { title: "Unpublished" }));
    await entry(await test.request("/api/admin/entries/projects", "POST", { title: "Other type" }));
    // Seed publications only; step 7 owns actual transitions. Advance the shared revision like a transition must.
    await test.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        for (const value of [unchanged, changing]) {
          yield* sql`update content_entries set first_published_at = '2025-01-01T00:00:00.000Z', revision = revision + 1 where id = ${value.id}`;

          // Reorder field keys to verify state is semantic, not serialized JSON equality.
          const snapshot =
            value.id === unchanged.id
              ? { ...value.draft, fields: { summary: "Text", tags: ["a", "b"] } }
              : value.draft;

          yield* sql`insert into content_snapshots(entry_id, kind, content_json, published_at) values (${value.id}, 'published', ${JSON.stringify(snapshot)}, '2025-01-01T00:00:00.000Z')`;
        }
      }),
    );
    expect(
      (
        await test.request(`${base}/${changing.id}`, "PUT", {
          revision: 1,
          content: changing.draft,
        })
      ).status,
    ).toBe(409);

    const updated = await entry(
      await test.request(`${base}/${changing.id}`, "PUT", {
        revision: 2,
        content: { ...changing.draft, title: "Working draft" },
      }),
    );

    expect(updated.published?.content).toEqual(changing.draft);
    expect(updated.state).toBe("published-with-draft-changes");
    expect((await test.request(`${base}/${changing.id}`, "DELETE", { revision: 3 })).status).toBe(
      409,
    );
    expect(
      (
        await test.request(`${base}/${changing.id}`, "PUT", {
          revision: 3,
          content: { ...updated.draft, slug: "locked" },
        })
      ).status,
    ).toBe(409);

    for (const state of ["unpublished", "published", "published-with-draft-changes"]) {
      const result = await page(await test.request(`${base}?state=${state}`));
      expect(result.total).toBe(1);
      expect(result.items[0]?.state).toBe(state);
    }

    const searched = await page(await test.request(`${base}?search=%25_`));
    expect(searched.items.map((value) => value.id)).toEqual([unchanged.id]);
    expect((await page(await test.request(`${base}?search=WORKING`))).items[0]?.id).toBe(
      changing.id,
    );
    await test.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`update content_entries set updated_at = '2025-01-01T00:00:00.000Z'`;
      }),
    );
    const all = await page(await test.request(base));
    expect(all.items.map((value) => value.id)).toEqual(
      all.items.map((value) => value.id).toSorted((a, b) => a.localeCompare(b)),
    );
    const first = await page(await test.request(`${base}?limit=1&offset=0`));
    const next = await page(await test.request(`${base}?limit=1&offset=1`));
    expect(first.total).toBe(3);
    expect([first.items[0]?.id, next.items[0]?.id]).toEqual(
      all.items.slice(0, 2).map((value) => value.id),
    );
    expect((await page(await test.request(`${base}?offset=100`))).items).toEqual([]);
    await test.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`delete from content_snapshots where entry_id = ${changing.id} and kind = 'published'`;
        yield* sql`update content_entries set revision = revision + 1 where id = ${changing.id}`;
      }),
    );
    expect(
      (
        await test.request(`${base}/${changing.id}`, "PUT", {
          revision: 4,
          content: { ...updated.draft, slug: "still-locked" },
        })
      ).status,
    ).toBe(409);
    const historical = await entry(await test.request(`${base}/${changing.id}`));
    expect(historical).toMatchObject({
      state: "unpublished",
      firstPublishedAt: "2025-01-01T00:00:00.000Z",
    });
    expect((await test.request(`${base}/${changing.id}`, "DELETE", { revision: 4 })).status).toBe(
      200,
    );
  } finally {
    await test.close();
  }
});
