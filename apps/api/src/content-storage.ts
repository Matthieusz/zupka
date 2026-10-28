// @effect-diagnostics unstableApiUsage:off -- This adapter deliberately uses the pinned Effect SQL API.
import {
  ContentConfiguration,
  ContentTypeDefinition,
  ContentTypeId,
  DateTime,
  DraftData,
  EntryId,
  InvalidContentConfiguration,
  Slug,
  parseContentConfiguration,
  parseEntry,
} from "@zupka/shared";
import { Effect, Schema } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { createImageTables, replaceImageReferences } from "./image-storage.js";
import { withDatabaseTransaction } from "./database.js";

const Content = DraftData.fields.content;

const configurationJson = Schema.fromJsonString(ContentConfiguration);

const contentJson = Schema.fromJsonString(Content);

const strict = { onExcessProperty: "error" } as const;

/** A configuration change requires operator action; identifiers/reasons exclude authored field values. */
export class ContentConfigurationConflict extends Schema.TaggedError<
  ContentConfigurationConflict,
  { readonly brand: unique symbol }
>()("ContentConfigurationConflict", {
  typeId: Schema.String,
  fieldId: Schema.optionalKey(Schema.String),
  entryId: Schema.optionalKey(EntryId),
  snapshot: Schema.optionalKey(Schema.Literals(["draft", "published"])),
  reason: Schema.String,
}) {}

/** Persisted data failed decoding or disagrees with stable entry metadata; never silently repair it. */
export class CorruptContentStorage extends Schema.TaggedError<
  CorruptContentStorage,
  { readonly brand: unique symbol }
>()("CorruptContentStorage", { operation: Schema.String, cause: Schema.Defect() }) {}

/** Explicit data migrations must run sequentially against their exact recorded source configuration. */
export class ContentMigrationConflict extends Schema.TaggedError<
  ContentMigrationConflict,
  { readonly brand: unique symbol }
>()("ContentMigrationConflict", { reason: Schema.String }) {}

/** Versioned SQLite DDL, separate from the existing owner migration journal. */
export const migrateContent = Migrator.make({})({
  table: "content_sql_migrations",
  loader: Migrator.fromRecord({
    "0001_content": Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`create table content_definitions (
        id text primary key not null, definition_json text not null check(json_valid(definition_json))
      )`;
      yield* sql`create table content_entries (
        id text primary key not null,
        type_id text not null references content_definitions(id) on delete restrict,
        slug text not null check(length(slug) > 0),
        revision integer not null check(typeof(revision) = 'integer' and revision >= 1),
        created_at text not null, updated_at text not null, first_published_at text,
        unique(type_id, slug)
      )`;
      yield* sql`create index content_entries_type_updated on content_entries(type_id, updated_at desc, id)`;
      yield* sql`create index content_entries_type_published on content_entries(type_id, first_published_at desc, id)`;
      yield* sql`create table content_snapshots (
        entry_id text not null references content_entries(id) on delete cascade,
        kind text not null check(kind in ('draft', 'published')),
        content_json text not null check(json_valid(content_json)),
        published_at text,
        primary key(entry_id, kind),
        check((kind = 'draft' and published_at is null) or (kind = 'published' and published_at is not null))
      )`;
      yield* sql`create index content_snapshot_title on content_snapshots(kind, json_extract(content_json, '$.title'), entry_id)`;
      yield* sql`create table content_data_migrations (
        version integer primary key check(typeof(version) = 'integer' and version >= 1), name text not null,
        from_json text not null check(json_valid(from_json)), to_json text not null check(json_valid(to_json))
      )`;
      yield* sql`create trigger content_identity_immutable before update of id, type_id on content_entries
        when new.id != old.id or new.type_id != old.type_id
        begin select raise(abort, 'Entry identity is immutable'); end`;
      yield* sql`create trigger content_slug_locked before update of slug on content_entries
        when old.first_published_at is not null and new.slug != old.slug
        begin select raise(abort, 'Slug is locked after first publication'); end`;
      yield* sql`create trigger content_first_publication_locked before update of first_published_at on content_entries
        when old.first_published_at is not null and new.first_published_at is not old.first_published_at
        begin select raise(abort, 'First publication is immutable'); end`;

      for (const operation of ["insert", "update"] as const) {
        yield* sql.unsafe(`create trigger content_snapshot_${operation} before ${operation} on content_snapshots
          when json_extract(new.content_json, '$.slug') is not (select slug from content_entries where id = new.entry_id)
            or (new.kind = 'published' and (select first_published_at from content_entries where id = new.entry_id) is null)
          begin select raise(abort, 'Snapshot identity or publication metadata mismatch'); end`);
      }
    }),
    "0002_images": createImageTables,
  }),
});

const DefinitionRow = Schema.Struct({ id: ContentTypeId, definition_json: Schema.String });

const Metadata = Schema.Struct({
  id: EntryId,
  type_id: ContentTypeId,
  slug: Slug,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  created_at: DateTime,
  updated_at: DateTime,
  first_published_at: Schema.NullOr(DateTime),
});

const SnapshotRow = Schema.Struct({
  entry_id: EntryId,
  kind: Schema.Literals(["draft", "published"]),
  content_json: Schema.String,
  published_at: Schema.NullOr(DateTime),
});

/** Decoded entry with immutable identity/history separated from independently validated snapshots. */
export const StoredEntry = Schema.Struct({
  id: EntryId,
  typeId: ContentTypeId,
  slug: Slug,
  revision: Metadata.fields.revision,
  createdAt: DateTime,
  updatedAt: DateTime,
  firstPublishedAt: Schema.NullOr(DateTime),
  draft: Content,
  published: Schema.NullOr(Schema.Struct({ content: Content, publishedAt: DateTime })),
});

/** Decoded persistence result; no stored status flags can contradict snapshot availability. */
export interface StoredEntry extends Schema.Schema.Type<typeof StoredEntry> {}

const corrupt = (operation: string) =>
  Effect.mapError((cause: Schema.SchemaError) => new CorruptContentStorage({ operation, cause }));

/** Read the schema-validated configuration accepted by the current database. */
export const readDefinitions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`select id, definition_json from content_definitions order by id`;

  const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(DefinitionRow))(rows).pipe(
    corrupt("read definitions"),
  );

  const types: ContentTypeDefinition[] = [];

  for (const row of decoded) {
    const type = yield* Schema.decodeEffect(
      Schema.fromJsonString(ContentTypeDefinition),
      strict,
    )(row.definition_json).pipe(corrupt("decode definition"));

    if (type.id !== row.id)
      return yield* new CorruptContentStorage({
        operation: "definition identity",
        cause: "Definition id differs from its key",
      });
    types.push(type);
  }

  return yield* Schema.decodeEffect(ContentConfiguration)(types).pipe(
    corrupt("decode configuration"),
  );
});

const writeDefinitions = Effect.fn("ContentStorage.writeDefinitions")(function* (
  types: typeof ContentConfiguration.Type,
) {
  const sql = yield* SqlClient.SqlClient;

  for (const type of types) {
    const json = yield* Schema.encodeEffect(Schema.fromJsonString(ContentTypeDefinition))(type);
    yield* sql`insert into content_definitions(id, definition_json) values (${type.id}, ${json})
      on conflict(id) do update set definition_json = excluded.definition_json`;
  }

  // Foreign keys prevent a migration from removing a type that still owns entries.
  const old = yield* readDefinitions;

  for (const type of old) {
    if (!types.some((next) => next.id === type.id))
      yield* sql`delete from content_definitions where id = ${type.id}`;
  }
});

function definitionConflicts(
  previous: typeof ContentConfiguration.Type,
  proposed: typeof ContentConfiguration.Type,
) {
  const conflicts: ContentConfigurationConflict[] = [];

  for (const old of previous) {
    const next = proposed.find((type) => type.id === old.id);

    if (!next) {
      conflicts.push(
        new ContentConfigurationConflict({
          typeId: old.id,
          reason: "Removing a content type requires an explicit data migration.",
        }),
      );
      continue;
    }

    for (const field of old.fields) {
      const replacement = next.fields.find((item) => item.id === field.id);

      const reason = !replacement
        ? "Removing a field requires an explicit data migration."
        : replacement.kind !== field.kind
          ? "Changing a field kind requires an explicit data migration."
          : !field.required && replacement.required
            ? "Making a field required requires an explicit data migration."
            : field.kind === "select" &&
                replacement.kind === "select" &&
                field.choices.some((choice) => !replacement.choices.includes(choice))
              ? "Removing select choices requires an explicit data migration."
              : undefined;

      if (reason)
        conflicts.push(
          new ContentConfigurationConflict({ typeId: old.id, fieldId: field.id, reason }),
        );
    }

    for (const field of next.fields) {
      if (field.required && !old.fields.some((item) => item.id === field.id))
        conflicts.push(
          new ContentConfigurationConflict({
            typeId: old.id,
            fieldId: field.id,
            reason: "Adding a required field requires an explicit data migration.",
          }),
        );
    }
  }

  return conflicts;
}

const readEntries = Effect.fn("ContentStorage.readEntries")(function* (
  types: typeof ContentConfiguration.Type,
  ids?: readonly (typeof EntryId.Type)[],
) {
  if (ids?.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;

  const metadata = yield* Schema.decodeUnknownEffect(Schema.Array(Metadata))(
    yield* sql`select * from content_entries where ${ids ? sql.in("id", ids) : sql`1 = 1`} order by id`,
  ).pipe(corrupt("read entries"));

  const snapshots = yield* Schema.decodeUnknownEffect(Schema.Array(SnapshotRow))(
    yield* sql`select * from content_snapshots where ${ids ? sql.in("entry_id", ids) : sql`1 = 1`} order by entry_id, kind`,
  ).pipe(corrupt("read snapshots"));

  const entries: StoredEntry[] = [];

  for (const row of metadata) {
    const type = types.find((definition) => definition.id === row.type_id);

    if (!type)
      return yield* new ContentConfigurationConflict({
        typeId: row.type_id,
        entryId: row.id,
        reason: "Entry content type is missing. Restore its definition or migrate its entries.",
      });
    let draft: typeof Content.Type | undefined;
    let published: StoredEntry["published"] = null;

    for (const snapshot of snapshots) {
      if (snapshot.entry_id !== row.id) continue;

      const raw = yield* Schema.decodeEffect(
        contentJson,
        strict,
      )(snapshot.content_json).pipe(corrupt("decode snapshot JSON"));

      const content = yield* parseEntry(
        type,
        snapshot.kind === "draft" ? "draft" : "publish",
        raw,
      ).pipe(
        Effect.mapError(
          () =>
            new ContentConfigurationConflict({
              typeId: type.id,
              entryId: row.id,
              snapshot: snapshot.kind,
              reason:
                "Saved snapshot does not satisfy the configured fields. Restore the accepted configuration or provide an explicit data migration.",
            }),
        ),
      );

      if (content.slug !== row.slug)
        return yield* new CorruptContentStorage({
          operation: "snapshot identity",
          cause: "Snapshot slug differs from entry slug",
        });

      // Decode through the common content schema after configured-field parsing.
      const parsed = yield* Schema.decodeUnknownEffect(Content)(content).pipe(
        corrupt("snapshot content"),
      );

      if (snapshot.kind === "draft") {
        if (snapshot.published_at !== null)
          return yield* new CorruptContentStorage({
            operation: "draft timestamp",
            cause: "Draft has a publication timestamp",
          });
        draft = parsed;
      } else {
        if (snapshot.published_at === null || row.first_published_at === null)
          return yield* new CorruptContentStorage({
            operation: "publication history",
            cause: "Missing publication timestamp",
          });
        published = { content: parsed, publishedAt: snapshot.published_at };
      }
    }

    if (!draft)
      return yield* new CorruptContentStorage({
        operation: "read draft",
        cause: "Entry has no draft",
      });
    entries.push({
      id: row.id,
      typeId: row.type_id,
      slug: row.slug,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      firstPublishedAt: row.first_published_at,
      draft,
      published,
    });
  }

  return entries;
});

const synchronizeReferences = Effect.fn("ContentStorage.synchronizeImageReferences")(function* (
  types: typeof ContentConfiguration.Type,
  entries: readonly StoredEntry[],
) {
  for (const entry of entries) {
    const type = types.find((item) => item.id === entry.typeId);

    if (!type)
      return yield* new CorruptContentStorage({
        operation: "image references",
        cause: "Missing content definition",
      });
    yield* replaceImageReferences(entry.id, "draft", type, entry.draft);

    if (entry.published)
      yield* replaceImageReferences(entry.id, "published", type, entry.published.content);
  }
});

/** Atomically accept safe configuration changes only after validating every saved draft/publication.
 * Never rewrites snapshots or applies new defaults. Failure leaves the accepted definitions untouched.
 */
export const acceptContentConfiguration = Effect.fn("ContentStorage.acceptConfiguration")(
  function* (input: typeof ContentConfiguration.Encoded) {
    const proposed = yield* parseContentConfiguration(input).pipe(
      Effect.mapError((cause) => new InvalidContentConfiguration({ cause })),
    );

    return yield* withDatabaseTransaction(
      Effect.gen(function* () {
        const previous = yield* readDefinitions;
        // Validate existing data against its recorded definitions before any adoption.
        yield* readEntries(previous);
        const [conflict] = definitionConflicts(previous, proposed);

        if (conflict) return yield* conflict;
        const entries = yield* readEntries(proposed);
        yield* synchronizeReferences(proposed, entries);
        yield* writeDefinitions(proposed);

        return proposed;
      }),
    );
  },
);

/** Fresh draft persistence input; callers choose stable identity/time and create defaults explicitly. */
export const NewStoredDraft = Schema.Struct({
  id: EntryId,
  typeId: ContentTypeId,
  createdAt: DateTime,
  content: Content,
});

/** Insert a new schema-validated draft atomically; uniqueness/foreign-key failures remain typed SQL errors.
 * This is a persistence seam, not an authenticated management operation or publication transition.
 */
export const insertStoredDraft = Effect.fn("ContentStorage.insertDraft")(function* (
  input: typeof NewStoredDraft.Encoded,
) {
  const draft = yield* Schema.decodeEffect(NewStoredDraft, strict)(input);
  const sql = yield* SqlClient.SqlClient;

  return yield* withDatabaseTransaction(
    Effect.gen(function* () {
      const types = yield* readDefinitions;
      const type = types.find((definition) => definition.id === draft.typeId);

      if (!type)
        return yield* new ContentConfigurationConflict({
          typeId: draft.typeId,
          reason: "Content type has not been accepted.",
        });
      const parsed = yield* parseEntry(type, "draft", draft.content);
      const content = yield* Schema.decodeUnknownEffect(Content)(parsed);
      const json = yield* Schema.encodeEffect(contentJson)(content);
      yield* sql`insert into content_entries (id, type_id, slug, revision, created_at, updated_at)
      values (${draft.id}, ${draft.typeId}, ${content.slug}, 1, ${draft.createdAt}, ${draft.createdAt})`;
      yield* sql`insert into content_snapshots (entry_id, kind, content_json) values (${draft.id}, 'draft', ${json})`;
      yield* replaceImageReferences(draft.id, "draft", type, content);

      return draft.id;
    }),
  );
});

/** Read validated entries and snapshots against accepted definitions in a consistent transaction. */
export const listStoredEntries = withDatabaseTransaction(
  Effect.gen(function* () {
    return yield* readEntries(yield* readDefinitions);
  }),
);

/** Read only selected, schema-validated entries; callers own the surrounding transaction. */
export const readStoredEntries = Effect.fn("ContentStorage.readSelected")(function* (
  ids: readonly (typeof EntryId.Type)[],
) {
  return yield* readEntries(yield* readDefinitions, ids);
});

/** Parsed header for an operator-authored, sequential content data migration. */
export const ContentMigrationHeader = Schema.Struct({
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/)),
  from: ContentConfiguration,
  to: ContentConfiguration,
});

/** Explicit migration input; conversion runs per saved snapshot, never applying defaults implicitly.
 * The pure callback cannot change identity, slug, or publication history; return those fields unchanged.
 */
export interface ContentDataMigration {
  readonly header: typeof ContentMigrationHeader.Encoded;
  readonly transform: (
    entry: StoredEntry,
    kind: "draft" | "published",
    content: typeof Content.Type,
  ) => typeof Content.Encoded;
}

/** Apply a versioned conversion, validate all results, and record definitions/data/journal atomically.
 * Run only in an operator-controlled maintenance window with the normal service stopped.
 * Conversion exceptions are defects; transactions still roll back. Expected validation failures are typed.
 */
export const migrateContentData = Effect.fn("ContentStorage.migrateData")(function* (
  migration: ContentDataMigration,
) {
  const header = yield* Schema.decodeEffect(ContentMigrationHeader, strict)(migration.header);
  const sql = yield* SqlClient.SqlClient;

  return yield* withDatabaseTransaction(
    Effect.gen(function* () {
      const previous = yield* readDefinitions;

      const sourceJson = yield* Schema.encodeEffect(configurationJson)(
        [...header.from].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      );

      const actualJson = yield* Schema.encodeEffect(configurationJson)(previous);

      if (sourceJson !== actualJson)
        return yield* new ContentMigrationConflict({
          reason: "Migration source does not match the accepted configuration.",
        });

      const versions = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ version: Schema.Int })),
      )(yield* sql`select version from content_data_migrations order by version desc limit 1`);

      if (header.version !== (versions[0]?.version ?? 0) + 1)
        return yield* new ContentMigrationConflict({
          reason: "Migration version must be the next unapplied sequential version.",
        });
      const entries = yield* readEntries(previous);

      for (const entry of entries) {
        for (const kind of ["draft", "published"] as const) {
          const content = kind === "draft" ? entry.draft : entry.published?.content;

          if (!content) continue;
          const type = header.to.find((definition) => definition.id === entry.typeId);

          if (!type)
            return yield* new ContentMigrationConflict({
              reason: "Cannot remove a content type while it still owns entries.",
            });
          const converted = migration.transform(entry, kind, content);
          const parsed = yield* parseEntry(type, kind === "draft" ? "draft" : "publish", converted);

          if (parsed.slug !== entry.slug)
            return yield* new ContentMigrationConflict({
              reason: "Content migrations cannot change stable identity or slugs.",
            });

          const json = yield* Schema.encodeEffect(contentJson)(
            yield* Schema.decodeUnknownEffect(Content)(parsed),
          );

          yield* sql`update content_snapshots set content_json = ${json} where entry_id = ${entry.id} and kind = ${kind}`;
        }

        // Invalidate open-editor revisions without changing authored timestamps or publication history.
        yield* sql`update content_entries set revision = revision + 1 where id = ${entry.id}`;
      }

      yield* synchronizeReferences(header.to, yield* readEntries(header.to));
      yield* writeDefinitions(header.to);
      const targetJson = yield* Schema.encodeEffect(configurationJson)(header.to);
      yield* sql`insert into content_data_migrations(version, name, from_json, to_json)
      values (${header.version}, ${header.name}, ${sourceJson}, ${targetJson})`;
    }),
  );
});
