// @effect-diagnostics unstableApiUsage:off -- Tests exercise the pinned production SQL APIs against real files.
import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ContentConfiguration, DraftData, EntryId, InvalidEntry } from "@zupka/shared";
import { ConfigProvider, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it } from "vite-plus/test";
import { migrateAuth } from "./auth.js";
import { Posts, Projects } from "./content-config.js";
import {
  acceptContentConfiguration,
  ContentConfigurationConflict,
  ContentMigrationConflict,
  CorruptContentStorage,
  insertStoredDraft,
  listStoredEntries,
  migrateContent,
  migrateContentData,
} from "./content-storage.js";
import { DatabaseLive, loadStoragePaths, StorageConfiguration } from "./database.js";
import { initializeStorage } from "./storage.js";

const id = "550e8400-e29b-41d4-a716-446655440000";

const secondId = "550e8400-e29b-41d4-a716-446655440001";

const time = "2025-01-01T00:00:00.000Z";

const later = "2025-02-01T00:00:00.000Z";

const content = { title: "A draft", slug: "a-draft", fields: { summary: "Original" } };

const configuration = [Posts, Projects];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "zupka-content-"));

  const config = ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      DATABASE_PATH: join(directory, "content.sqlite"),
      UPLOADS_PATH: join(directory, "images"),
    }),
  );

  const database = DatabaseLive.pipe(Layer.provide(config));

  return {
    // Every call opens and closes a new scope/connection, deliberately exercising restarts.
    run: <A, E>(program: Effect.Effect<A, E, SqlClient.SqlClient | StorageConfiguration>) =>
      Effect.runPromise(program.pipe(Effect.provide(database))),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

const seed = Effect.gen(function* () {
  yield* initializeStorage;
  yield* insertStoredDraft({ id, typeId: "posts", createdAt: time, content });
});

// Storage fixture only: publication workflows/image visibility are intentionally deferred to step 7.
const seedPublication = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const json = yield* Schema.encodeEffect(Schema.fromJsonString(DraftData.fields.content))(
    yield* Schema.decodeEffect(DraftData.fields.content)({
      title: "Public title",
      slug: content.slug,
      fields: { summary: "Public summary" },
    }),
  );

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`update content_entries set first_published_at = ${time} where id = ${id}`;
      yield* sql`insert into content_snapshots(entry_id, kind, content_json, published_at) values (${id}, 'published', ${json}, ${later})`;
    }),
  );
});

const rawState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    definitions: yield* sql`select * from content_definitions order by id`,
    entries: yield* sql`select * from content_entries order by id`,
    snapshots: yield* sql`select * from content_snapshots order by entry_id, kind`,
    migrations: yield* sql`select * from content_data_migrations order by version`,
  };
});

it("migrates fresh and owner-only databases without losing owner data and survives scoped restarts", async () => {
  const db = await fixture();

  try {
    await db.run(
      Effect.gen(function* () {
        yield* migrateAuth;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`insert into owners values ('owner', 1, 'existing-security-revision')`;
      }),
    );
    await db.run(seed);
    await db.run(seedPublication);
    await db.run(
      Effect.gen(function* () {
        yield* initializeStorage;
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`select * from owners`).toEqual([
          { id: "owner", active: 1, revision: "existing-security-revision" },
        ]);
        expect(yield* sql`select migration_id from content_sql_migrations`).toEqual([
          { migration_id: 1 },
          { migration_id: 2 },
        ]);
        expect(yield* sql`pragma foreign_keys`).toEqual([{ foreign_keys: 1 }]);
        expect(yield* sql`pragma busy_timeout`).toEqual([{ timeout: 0 }]);
        const [entry] = yield* listStoredEntries;
        expect(entry).toMatchObject({
          id,
          typeId: "posts",
          revision: 1,
          createdAt: time,
          firstPublishedAt: time,
          draft: content,
        });
        expect(entry?.published).toMatchObject({
          content: { title: "Public title", fields: { summary: "Public summary" } },
          publishedAt: later,
        });
      }),
    );
    const before = await db.run(rawState);
    await db.run(initializeStorage);
    expect(await db.run(rawState)).toEqual(before);
  } finally {
    await db.close();
  }
});

it("enforces per-type slug uniqueness and rolls back failed insertions", async () => {
  const db = await fixture();

  try {
    await db.run(seed);
    const before = await db.run(rawState);
    await expect(
      db.run(insertStoredDraft({ id: secondId, typeId: "posts", createdAt: time, content })),
    ).rejects.toThrow();
    expect(await db.run(rawState)).toEqual(before);
    await db.run(insertStoredDraft({ id: secondId, typeId: "projects", createdAt: time, content }));
    expect(await db.run(listStoredEntries)).toHaveLength(2);

    const invalid = await db.run(
      Effect.flip(
        insertStoredDraft({
          id: crypto.randomUUID(),
          typeId: "posts",
          createdAt: time,
          content: { ...content, slug: "invalid-field", fields: { tags: "not a list" } },
        }),
      ),
    );

    expect(invalid).toBeInstanceOf(InvalidEntry);
  } finally {
    await db.close();
  }
});

it("preserves first-publication history and locked slugs independently of public availability", async () => {
  const db = await fixture();

  try {
    await db.run(seed);
    await db.run(seedPublication);
    await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`delete from content_snapshots where entry_id = ${id} and kind = 'published'`;
        expect((yield* listStoredEntries)[0]).toMatchObject({
          firstPublishedAt: time,
          published: null,
        });
        expect(
          (yield* sql`update content_entries set slug = 'changed' where id = ${id}`.pipe(
            Effect.result,
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* sql`update content_entries set first_published_at = null where id = ${id}`.pipe(
            Effect.result,
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* sql`update content_entries set first_published_at = ${later} where id = ${id}`.pipe(
            Effect.result,
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* sql`update content_entries set type_id = 'projects' where id = ${id}`.pipe(
            Effect.result,
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* sql`update content_entries set revision = 0 where id = ${id}`.pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
      }),
    );
    expect((await db.run(listStoredEntries))[0]).toMatchObject({
      slug: content.slug,
      firstPublishedAt: time,
      published: null,
    });
  } finally {
    await db.close();
  }
});

it("accepts optional fields/new types/default and label edits without rewriting old snapshots", async () => {
  const db = await fixture();

  try {
    await db.run(seed);
    await db.run(seedPublication);
    const before = await db.run(rawState);

    const next = [
      {
        ...Posts,
        label: "Writing",
        fields: [
          ...Posts.fields,
          { id: "featured", label: "Featured", kind: "boolean", required: false, default: true },
        ],
      },
      Projects,
      { id: "notes", label: "Notes", fields: [] },
    ] satisfies typeof ContentConfiguration.Encoded;

    await db.run(acceptContentConfiguration(next));
    const after = await db.run(rawState);
    expect(after.snapshots).toEqual(before.snapshots);
    expect(after.entries).toEqual(before.entries);
    const [entry] = await db.run(listStoredEntries);
    expect(entry?.draft.fields).not.toHaveProperty("featured");
    expect(entry?.published?.content.fields).not.toHaveProperty("featured");
    await db.run(acceptContentConfiguration(next));
    expect(await db.run(rawState)).toEqual(after);
  } finally {
    await db.close();
  }
});

it("rejects incompatible definitions with actionable identities and no persisted changes", async () => {
  const db = await fixture();

  try {
    await db.run(seed);
    await db.run(seedPublication);
    const before = await db.run(rawState);

    const changes: (typeof ContentConfiguration.Encoded)[] = [
      [Projects],
      [{ ...Posts, fields: Posts.fields.filter((field) => field.id !== "summary") }, Projects],
      [
        {
          ...Posts,
          fields: Posts.fields.map((field) =>
            field.id === "summary" ? { ...field, kind: "number" } : field,
          ),
        },
        Projects,
      ],
      [{ ...Posts, fields: Posts.fields.map((field) => ({ ...field, required: true })) }, Projects],
      [
        {
          ...Posts,
          fields: [...Posts.fields, { id: "venue", label: "Venue", kind: "text", required: true }],
        },
        Projects,
      ],
    ];

    for (const next of changes) {
      const failure = await db.run(Effect.flip(acceptContentConfiguration(next)));
      expect(failure).toBeInstanceOf(ContentConfigurationConflict);
      expect(failure).toMatchObject({ typeId: "posts" });
      expect(await db.run(rawState)).toEqual(before);
    }
  } finally {
    await db.close();
  }
});

it("allows select extensions/required loosening but rejects choice removal even when unused", async () => {
  const db = await fixture();

  try {
    const original = [
      {
        id: "notes",
        label: "Notes",
        fields: [
          {
            id: "format",
            label: "Format",
            kind: "select",
            required: true,
            choices: ["A", "B"],
            default: "A",
          },
        ],
      },
    ] satisfies typeof ContentConfiguration.Encoded;

    await db.run(
      Effect.gen(function* () {
        yield* migrateContent;
        yield* acceptContentConfiguration(original);
      }),
    );

    const safe = [
      {
        id: "notes",
        label: "Notes",
        fields: [
          {
            id: "format",
            label: "Layout",
            kind: "select",
            required: false,
            choices: ["A", "B", "C"],
            default: "C",
          },
        ],
      },
    ] satisfies typeof ContentConfiguration.Encoded;

    await db.run(acceptContentConfiguration(safe));
    const before = await db.run(rawState);

    const incompatible = [
      {
        id: "notes",
        label: "Notes",
        fields: [
          { id: "format", label: "Layout", kind: "select", required: false, choices: ["A", "C"] },
        ],
      },
    ] satisfies typeof ContentConfiguration.Encoded;

    expect(await db.run(Effect.flip(acceptContentConfiguration(incompatible)))).toMatchObject({
      fieldId: "format",
    });
    expect(await db.run(rawState)).toEqual(before);
  } finally {
    await db.close();
  }
});

it("validates recorded drafts and publications before accepting any configuration", async () => {
  const db = await fixture();

  try {
    await db.run(seed);
    await db.run(seedPublication);
    // Bypass the adapter to simulate a valid JSON value corrupted by a prior writer.
    await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`update content_snapshots set content_json = json_set(content_json, '$.fields.tags', 7) where kind = 'published'`;
      }),
    );
    const before = await db.run(rawState);
    const failure = await db.run(Effect.flip(acceptContentConfiguration(configuration)));
    expect(failure).toBeInstanceOf(ContentConfigurationConflict);
    expect(failure).toMatchObject({ entryId: id, snapshot: "published", typeId: "posts" });
    expect(await db.run(rawState)).toEqual(before);
    await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`update content_snapshots set content_json = json_set(content_json, '$.fields', json('{}')) where kind = 'published'`;
        yield* sql`delete from content_snapshots where kind = 'draft'`;
      }),
    );
    expect(await db.run(Effect.flip(listStoredEntries))).toBeInstanceOf(CorruptContentStorage);
  } finally {
    await db.close();
  }
});

it("migrates both snapshots explicitly, records a sequential version, and preserves publication history", async () => {
  const db = await fixture();

  try {
    await db.run(seed);
    await db.run(seedPublication);

    const next = [
      {
        ...Posts,
        fields: Posts.fields.map((field) =>
          field.id === "summary"
            ? { id: "abstract", label: "Abstract", kind: "text", required: false }
            : field,
        ),
      },
      Projects,
    ] satisfies typeof ContentConfiguration.Encoded;

    const migration = {
      header: { version: 1, name: "rename-summary", from: configuration, to: next },
      transform: (
        _entry: typeof import("./content-storage.js").StoredEntry.Type,
        _kind: "draft" | "published",
        saved: typeof DraftData.fields.content.Type,
      ) => {
        const { summary, ...rest } = saved.fields;

        return { ...saved, fields: summary === undefined ? rest : { ...rest, abstract: summary } };
      },
    };

    await db.run(migrateContentData(migration));
    const [entry] = await db.run(listStoredEntries);
    expect(entry).toMatchObject({
      id,
      revision: 2,
      slug: content.slug,
      createdAt: time,
      updatedAt: time,
      firstPublishedAt: time,
    });
    expect(entry?.draft.fields).toEqual({ abstract: "Original" });
    expect(entry?.published).toMatchObject({
      publishedAt: later,
      content: { fields: { abstract: "Public summary" } },
    });
    await db.run(acceptContentConfiguration(next));
    const before = await db.run(rawState);
    expect(before.migrations).toHaveLength(1);
    expect(await db.run(Effect.flip(migrateContentData(migration)))).toBeInstanceOf(
      ContentMigrationConflict,
    );
    expect(await db.run(rawState)).toEqual(before);
  } finally {
    await db.close();
  }
});

it("rolls back conversions, definitions, revisions and journal if a later publication fails validation", async () => {
  const db = await fixture();

  try {
    await db.run(seed);
    await db.run(seedPublication);

    const next = [
      {
        ...Posts,
        fields: [...Posts.fields, { id: "venue", label: "Venue", kind: "text", required: true }],
      },
      Projects,
    ] satisfies typeof ContentConfiguration.Encoded;

    const before = await db.run(rawState);

    const failure = await db.run(
      Effect.flip(
        migrateContentData({
          header: { version: 1, name: "require-venue", from: configuration, to: next },
          transform: (_entry, _kind, saved) => saved,
        }),
      ),
    );

    expect(failure).toBeInstanceOf(InvalidEntry);
    expect(await db.run(rawState)).toEqual(before);

    const wrongVersion = await db.run(
      Effect.flip(
        migrateContentData({
          header: { version: 2, name: "skip-version", from: configuration, to: configuration },
          transform: (_entry, _kind, saved) => saved,
        }),
      ),
    );

    expect(wrongVersion).toBeInstanceOf(ContentMigrationConflict);

    const wrongSource = await db.run(
      Effect.flip(
        migrateContentData({
          header: { version: 1, name: "wrong-source", from: [Projects], to: configuration },
          transform: (_entry, _kind, saved) => saved,
        }),
      ),
    );

    expect(wrongSource).toBeInstanceOf(ContentMigrationConflict);
    expect(await db.run(rawState)).toEqual(before);
  } finally {
    await db.close();
  }
});

it("rolls back migration defects and rejects attempts to change slugs", async () => {
  const db = await fixture();

  try {
    await db.run(seed);
    await db.run(seedPublication);
    const before = await db.run(rawState);
    await expect(
      db.run(
        migrateContentData({
          header: {
            version: 1,
            name: "defective-conversion",
            from: configuration,
            to: configuration,
          },
          transform: (_entry, kind, saved) => {
            if (kind === "published") throw new Error("Conversion defect");

            return { ...saved, title: "Changed draft" };
          },
        }),
      ),
    ).rejects.toThrow();
    expect(await db.run(rawState)).toEqual(before);
    expect(
      await db.run(
        Effect.flip(
          migrateContentData({
            header: { version: 1, name: "change-slug", from: configuration, to: configuration },
            transform: (_entry, _kind, saved) => ({ ...saved, slug: "different" }),
          }),
        ),
      ),
    ).toBeInstanceOf(ContentMigrationConflict);
    expect(await db.run(rawState)).toEqual(before);
  } finally {
    await db.close();
  }
});

it("enforces snapshot/foreign-key constraints and refuses missing or mismatched publication history", async () => {
  const db = await fixture();

  try {
    await db.run(seed);
    await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        expect(
          (yield* sql`insert into content_snapshots(entry_id, kind, content_json) values (${secondId}, 'draft', ${JSON.stringify(content)})`.pipe(
            Effect.result,
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* sql`insert into content_snapshots(entry_id, kind, content_json, published_at) values (${id}, 'published', ${JSON.stringify(content)}, ${time})`.pipe(
            Effect.result,
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* sql`update content_snapshots set content_json = ${JSON.stringify({ ...content, slug: "different" })}`.pipe(
            Effect.result,
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* sql`delete from content_definitions where id = 'posts'`.pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* sql`update content_snapshots set content_json = 'invalid json'`.pipe(
            Effect.result,
          ))._tag,
        ).toBe("Failure");
      }),
    );
    expect(await db.run(listStoredEntries)).toHaveLength(1);
  } finally {
    await db.close();
  }
});

it("rejects an unconfigured migration command before opening or creating a database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zupka-content-command-"));
  const filename = join(directory, "must-not-exist.sqlite");

  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/migrate-content.ts", "1"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { ...process.env, DATABASE_PATH: filename, UPLOADS_PATH: join(directory, "images") },
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("configured-version");
    expect(result.stderr).not.toContain(filename);
    await expect(access(filename)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("validates runtime storage paths and rejects ephemeral or overlapping locations", async () => {
  for (const paths of [
    { DATABASE_PATH: "" },
    { DATABASE_PATH: ":memory:" },
    { DATABASE_PATH: "file:ephemeral" },
    { DATABASE_PATH: "bad\0path" },
    { UPLOADS_PATH: " " },
    { DATABASE_PATH: "uploads/db.sqlite", UPLOADS_PATH: "uploads" },
    { DATABASE_PATH: "uploads", UPLOADS_PATH: "uploads" },
    { DATABASE_PATH: "/tmp/db.sqlite", UPLOADS_PATH: "/" },
  ]) {
    const result = await Effect.runPromise(
      loadStoragePaths.pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown(paths, { preserveEmptyStrings: true })),
        ),
        Effect.result,
      ),
    );

    expect(result._tag, JSON.stringify(paths)).toBe("Failure");
  }

  const parsed = await Effect.runPromise(
    loadStoragePaths.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            DATABASE_PATH: "data/cms.sqlite",
            UPLOADS_PATH: "data/images",
          }),
        ),
      ),
    ),
  );

  expect(parsed).toEqual({
    databasePath: resolve("data/cms.sqlite"),
    uploadsPath: resolve("data/images"),
  });
  expect(Schema.is(EntryId)(id)).toBe(true);
});
