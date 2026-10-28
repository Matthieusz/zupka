// @effect-diagnostics unstableApiUsage:off -- This module owns transactional draft management with the pinned SQL API.
import { isDeepStrictEqual } from "node:util";
import {
  AdminEntry,
  CreateEntry,
  EntryError,
  EntryInvalid,
  EntryListQuery,
  EntryNotFound,
  PublicationTransition,
  SaveEntry,
} from "@zupka/contracts";
import {
  ContentTypeId,
  DraftData,
  EntryId,
  InvalidImageReference,
  createDraft,
  parseEntry,
  suggestSlug,
} from "@zupka/shared";
import { Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import {
  insertStoredDraft,
  readDefinitions,
  readStoredEntries,
  type StoredEntry,
} from "./content-storage.js";
import { replaceImageReferences } from "./image-storage.js";
import { CurrentOwner } from "./owner-http.js";
import { withDatabaseTransaction } from "./database.js";

/** Internal storage failure retains its cause; HTTP projects only an opaque unavailable response. */
export class EntryStorageFailure extends Schema.TaggedError<
  EntryStorageFailure,
  { readonly brand: unique symbol }
>()("EntryStorageFailure", { cause: Schema.Defect() }) {}

const strict = { onExcessProperty: "error" } as const;

const contentJson = Schema.fromJsonString(DraftData.fields.content);

const storageFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      Schema.is(EntryError)(error) ||
      Schema.is(EntryInvalid)(error) ||
      Schema.is(EntryNotFound)(error) ||
      Schema.is(InvalidImageReference)(error)
        ? error
        : new EntryStorageFailure({ cause: error }),
    ),
  );

const definition = Effect.fn("Entries.definition")(function* (typeId: typeof ContentTypeId.Type) {
  const type = (yield* readDefinitions).find((item) => item.id === typeId);

  if (!type) return yield* new EntryNotFound({});

  return type;
});

const stored = Effect.fn("Entries.stored")(function* (
  typeId: typeof ContentTypeId.Type,
  id: typeof EntryId.Type,
) {
  yield* definition(typeId);
  const [entry] = yield* readStoredEntries([id]);

  if (!entry || entry.typeId !== typeId) return yield* new EntryNotFound({});

  return entry;
});

const project = (entry: StoredEntry): typeof AdminEntry.Type => ({
  id: entry.id,
  typeId: entry.typeId,
  revision: entry.revision,
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
  firstPublishedAt: entry.firstPublishedAt,
  draft: entry.draft,
  published: entry.published,
  state:
    entry.published === null
      ? "unpublished"
      : isDeepStrictEqual(entry.draft, entry.published.content)
        ? "published"
        : "published-with-draft-changes",
});

const uniqueSlug = Effect.fn("Entries.uniqueSlug")(function* (
  typeId: typeof ContentTypeId.Type,
  slug: string,
  except: string,
) {
  const sql = yield* SqlClient.SqlClient;

  const rows =
    yield* sql`select id from content_entries where type_id = ${typeId} and slug = ${slug} and id != ${except} limit 1`;

  if (rows.length > 0) return yield* new EntryError({ reason: "slug-taken" });
});

/** Safe configured descriptions for generated editors; requires current owner authority. */
export const entryTypes = Effect.gen(function* () {
  yield* CurrentOwner;

  return yield* readDefinitions;
}).pipe(Effect.mapError((cause) => new EntryStorageFailure({ cause })));

/** Create a private draft with initial defaults and an editable suggested slug. Duplicate suggestions conflict. */
export const createEntry = Effect.fn("Entries.create")(
  function* (typeId: typeof ContentTypeId.Type, input: typeof CreateEntry.Type) {
    yield* CurrentOwner;

    const parsed = yield* Schema.decodeEffect(
      CreateEntry,
      strict,
    )(input).pipe(Effect.mapError(() => new EntryInvalid({})));

    return yield* withDatabaseTransaction(
      Effect.gen(function* () {
        const type = yield* definition(typeId);

        const draft = yield* createDraft(type, {
          title: parsed.title,
          slug: parsed.slug ?? suggestSlug(parsed.title),
          fields: parsed.fields ?? {},
        });

        const id = yield* Schema.decodeEffect(EntryId)(crypto.randomUUID());
        yield* uniqueSlug(typeId, draft.slug, id);
        const time = new Date(yield* Clock.currentTimeMillis).toISOString();
        yield* insertStoredDraft({
          id,
          typeId,
          createdAt: time,
          content: yield* Schema.decodeUnknownEffect(DraftData.fields.content)(draft),
        });

        return project(yield* stored(typeId, id));
      }),
    );
  },
  Effect.catchTag("InvalidEntry", () => Effect.fail(new EntryInvalid({}))),
  storageFailure,
);

/** Retrieve a complete private editing snapshot and its revision, scoped to a configured type. */
export const getEntry = Effect.fn("Entries.get")(function* (
  typeId: typeof ContentTypeId.Type,
  id: typeof EntryId.Type,
) {
  yield* CurrentOwner;

  return yield* withDatabaseTransaction(Effect.map(stored(typeId, id), project));
}, storageFailure);

/** Replace only the working draft. BEGIN IMMEDIATE plus revision predicates serialize competing writers.
 * Any publication transition must use and advance the same entry revision in its transaction.
 */
export const saveEntry = Effect.fn("Entries.save")(
  function* (
    typeId: typeof ContentTypeId.Type,
    id: typeof EntryId.Type,
    input: typeof SaveEntry.Type,
  ) {
    yield* CurrentOwner;

    const parsed = yield* Schema.decodeEffect(
      SaveEntry,
      strict,
    )(input).pipe(Effect.mapError(() => new EntryInvalid({})));

    const sql = yield* SqlClient.SqlClient;

    return yield* withDatabaseTransaction(
      Effect.gen(function* () {
        const entry = yield* stored(typeId, id);

        if (entry.revision !== parsed.revision)
          return yield* new EntryError({ reason: "stale-revision" });
        const draft = yield* parseEntry(yield* definition(typeId), "draft", parsed.content);

        if (entry.firstPublishedAt !== null && entry.slug !== draft.slug)
          return yield* new EntryError({ reason: "slug-locked" });
        yield* uniqueSlug(typeId, draft.slug, id);

        const json = yield* Schema.encodeEffect(contentJson)(
          yield* Schema.decodeUnknownEffect(DraftData.fields.content)(draft),
        );

        const time = new Date(yield* Clock.currentTimeMillis).toISOString();

        const changed =
          yield* sql`update content_entries set slug = ${draft.slug}, revision = revision + 1, updated_at = ${time}
      where id = ${id} and revision = ${parsed.revision} returning id`;

        if (changed.length !== 1) return yield* new EntryError({ reason: "stale-revision" });
        yield* sql`update content_snapshots set content_json = ${json} where entry_id = ${id} and kind = 'draft'`;
        yield* replaceImageReferences(
          id,
          "draft",
          yield* definition(typeId),
          yield* Schema.decodeUnknownEffect(DraftData.fields.content)(draft),
        );

        return project(yield* stored(typeId, id));
      }),
    );
  },
  Effect.catchTag("InvalidEntry", () => Effect.fail(new EntryInvalid({}))),
  storageFailure,
);

/** Validate the saved draft for publication and replace its public snapshot/references atomically.
 * First-publication history is set once; every publish advances the shared editing revision.
 */
export const publishEntry = Effect.fn("Entries.publish")(
  function* (
    typeId: typeof ContentTypeId.Type,
    id: typeof EntryId.Type,
    input: typeof PublicationTransition.Type,
  ) {
    yield* CurrentOwner;

    const parsed = yield* Schema.decodeEffect(
      PublicationTransition,
      strict,
    )(input).pipe(Effect.mapError(() => new EntryInvalid({})));

    const sql = yield* SqlClient.SqlClient;

    return yield* withDatabaseTransaction(
      Effect.gen(function* () {
        const entry = yield* stored(typeId, id);

        if (entry.revision !== parsed.revision)
          return yield* new EntryError({ reason: "stale-revision" });
        const type = yield* definition(typeId);

        const content = yield* Schema.decodeUnknownEffect(DraftData.fields.content)(
          yield* parseEntry(type, "publish", entry.draft),
        );

        const json = yield* Schema.encodeEffect(contentJson)(content);
        const time = new Date(yield* Clock.currentTimeMillis).toISOString();

        const changed =
          yield* sql`update content_entries set first_published_at = coalesce(first_published_at, ${time}),
        revision = revision + 1, updated_at = ${time} where id = ${id} and revision = ${parsed.revision} returning id`;

        if (changed.length !== 1) return yield* new EntryError({ reason: "stale-revision" });
        yield* sql`insert into content_snapshots(entry_id, kind, content_json, published_at)
        values (${id}, 'published', ${json}, ${time})
        on conflict(entry_id, kind) do update set content_json = excluded.content_json, published_at = excluded.published_at`;
        yield* replaceImageReferences(id, "published", type, content);

        return project(yield* stored(typeId, id));
      }),
    );
  },
  Effect.catchTag("InvalidEntry", () => Effect.fail(new EntryInvalid({}))),
  storageFailure,
);

/** Remove current public availability and its references, retaining the working draft and immutable history.
 * Even an already-unpublished command advances the revision, so stale overlapping commands still conflict.
 */
export const unpublishEntry = Effect.fn("Entries.unpublish")(function* (
  typeId: typeof ContentTypeId.Type,
  id: typeof EntryId.Type,
  input: typeof PublicationTransition.Type,
) {
  yield* CurrentOwner;

  const parsed = yield* Schema.decodeEffect(
    PublicationTransition,
    strict,
  )(input).pipe(Effect.mapError(() => new EntryInvalid({})));

  const sql = yield* SqlClient.SqlClient;

  return yield* withDatabaseTransaction(
    Effect.gen(function* () {
      const entry = yield* stored(typeId, id);

      if (entry.revision !== parsed.revision)
        return yield* new EntryError({ reason: "stale-revision" });
      const time = new Date(yield* Clock.currentTimeMillis).toISOString();

      const changed =
        yield* sql`update content_entries set revision = revision + 1, updated_at = ${time}
      where id = ${id} and revision = ${parsed.revision} returning id`;

      if (changed.length !== 1) return yield* new EntryError({ reason: "stale-revision" });
      // The snapshot foreign key cascades precisely this publication's image references.
      yield* sql`delete from content_snapshots where entry_id = ${id} and kind = 'published'`;

      return project(yield* stored(typeId, id));
    }),
  );
}, storageFailure);

/** Permanently delete only an unpublished entry at the expected revision; cascades its saved snapshots. */
export const deleteEntry = Effect.fn("Entries.delete")(function* (
  typeId: typeof ContentTypeId.Type,
  id: typeof EntryId.Type,
  revision: number,
) {
  yield* CurrentOwner;
  const sql = yield* SqlClient.SqlClient;

  return yield* withDatabaseTransaction(
    Effect.gen(function* () {
      const entry = yield* stored(typeId, id);

      if (entry.revision !== revision) return yield* new EntryError({ reason: "stale-revision" });

      if (entry.published !== null) return yield* new EntryError({ reason: "published-entry" });

      const changed =
        yield* sql`delete from content_entries where id = ${id} and revision = ${revision}
      and not exists (select 1 from content_snapshots where entry_id = ${id} and kind = 'published') returning id`;

      if (changed.length !== 1) return yield* new EntryError({ reason: "stale-revision" });

      return { deleted: id };
    }),
  );
}, storageFailure);

/** List by literal draft-title substring and actual publication state, with stable bounded pagination.
 * JSON tree comparisons ignore object-key ordering but preserve array order, types, and missing values.
 */
export const listEntries = Effect.fn("Entries.list")(function* (
  typeId: typeof ContentTypeId.Type,
  query: typeof EntryListQuery.Type,
) {
  yield* CurrentOwner;
  const sql = yield* SqlClient.SqlClient;
  const limit = query.limit ?? 20;
  const offset = query.offset ?? 0;

  return yield* withDatabaseTransaction(
    Effect.gen(function* () {
      yield* definition(typeId);

      const filtered = sql`with entry_states as (
      select e.id, e.updated_at,
        case when p.entry_id is null then 'unpublished'
          when not exists (
            select fullkey, type, atom from json_tree(d.content_json)
            except select fullkey, type, atom from json_tree(p.content_json)
          ) and not exists (
            select fullkey, type, atom from json_tree(p.content_json)
            except select fullkey, type, atom from json_tree(d.content_json)
          ) then 'published' else 'published-with-draft-changes' end as state
      from content_entries e join content_snapshots d on d.entry_id = e.id and d.kind = 'draft'
      left join content_snapshots p on p.entry_id = e.id and p.kind = 'published'
      where e.type_id = ${typeId} and instr(lower(json_extract(d.content_json, '$.title')), lower(${query.search ?? ""})) > 0
    )`;

      const where = query.state ? sql`state = ${query.state}` : sql`1 = 1`;

      const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: EntryId })))(
        yield* sql`${filtered} select id from entry_states where ${where} order by updated_at desc, id asc limit ${limit} offset ${offset}`,
      );

      const counts = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ total: Schema.Int })),
      )(yield* sql`${filtered} select count(*) as total from entry_states where ${where}`);

      const entries = yield* readStoredEntries(rows.map((row) => row.id));
      const byId = new Map(entries.map((entry) => [entry.id, project(entry)]));
      const items: (typeof AdminEntry.Type)[] = [];

      for (const row of rows) {
        const entry = byId.get(row.id);

        if (!entry) return yield* new EntryStorageFailure({ cause: "Selected entry is missing" });
        items.push(entry);
      }

      return { items, total: counts[0]?.total ?? 0, limit, offset };
    }),
  );
}, storageFailure);
