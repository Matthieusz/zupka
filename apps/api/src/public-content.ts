// @effect-diagnostics unstableApiUsage:off -- Published-only SQL reads share the production transaction boundary.
import { EntryNotFound, PublicContentQuery, PublicEntry, PublicFieldValue } from "@zupka/contracts";
import {
  ContentTypeDefinition,
  ContentTypeId,
  DateTime,
  DraftData,
  EntryId,
  ImageReference,
  Slug,
  managedImageUrl,
  parseEntry,
} from "@zupka/shared";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { readDefinitions } from "./content-storage.js";
import { withDatabaseTransaction } from "./database.js";

/** Internal publication read failure; retains diagnostics while HTTP returns an opaque 503. */
export class PublicContentStorageFailure extends Schema.TaggedError<
  PublicContentStorageFailure,
  { readonly brand: unique symbol }
>()("PublicContentStorageFailure", { cause: Schema.Defect() }) {}

const PublishedRow = Schema.Struct({
  id: EntryId,
  slug: Slug,
  first_published_at: DateTime,
  published_at: DateTime,
  content_json: Schema.String,
});

const definition = Effect.fn("PublicContent.definition")(function* (
  typeId: typeof ContentTypeId.Type,
) {
  const type = (yield* readDefinitions).find((item) => item.id === typeId);

  if (!type) return yield* new EntryNotFound({});

  return type;
});

const project = Effect.fn("PublicContent.project")(function* (
  type: ContentTypeDefinition,
  row: typeof PublishedRow.Type,
) {
  const raw = yield* Schema.decodeEffect(Schema.fromJsonString(DraftData.fields.content), {
    onExcessProperty: "error",
  })(row.content_json);

  const content = yield* parseEntry(type, "publish", raw);

  if (content.slug !== row.slug)
    return yield* new PublicContentStorageFailure({
      cause: "Published slug differs from entry identity",
    });
  const fields: Record<string, typeof PublicFieldValue.Type> = {};

  for (const field of type.fields) {
    const value = content.fields[field.id];

    if (value === undefined) continue;

    if (field.kind === "image") {
      const image = yield* Schema.decodeUnknownEffect(ImageReference)(value);
      fields[field.id] = { url: managedImageUrl(image.imageId), alt: image.alt };
    } else {
      fields[field.id] = yield* Schema.decodeUnknownEffect(PublicFieldValue)(value);
    }
  }

  return yield* Schema.decodeEffect(PublicEntry)({
    id: row.id,
    typeId: type.id,
    title: content.title,
    slug: content.slug,
    firstPublishedAt: row.first_published_at,
    publishedAt: row.published_at,
    fields,
  });
});

const storageFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      Schema.is(EntryNotFound)(error) ? error : new PublicContentStorageFailure({ cause: error }),
    ),
  );

/** Read only the current published snapshot by type/slug; cookies never reveal a working draft here. */
export const getPublicEntry = Effect.fn("PublicContent.get")(function* (
  typeId: typeof ContentTypeId.Type,
  slug: typeof Slug.Type,
) {
  const sql = yield* SqlClient.SqlClient;

  return yield* withDatabaseTransaction(
    Effect.gen(function* () {
      const type = yield* definition(typeId);

      const rows = yield* Schema.decodeUnknownEffect(Schema.Array(PublishedRow))(
        yield* sql`select e.id, e.slug, e.first_published_at, p.published_at, p.content_json
        from content_entries e join content_snapshots p on p.entry_id = e.id and p.kind = 'published'
        where e.type_id = ${typeId} and e.slug = ${slug}`,
      );

      const row = rows[0];

      if (!row) return yield* new EntryNotFound({});

      return yield* project(type, row);
    }),
  );
}, storageFailure);

/** Page published snapshots in one consistent transaction; drafts never participate in selection or ordering.
 * Posts use their published publication-date (even future dates); all others use immutable first publication.
 */
export const listPublicEntries = Effect.fn("PublicContent.list")(function* (
  typeId: typeof ContentTypeId.Type,
  query: typeof PublicContentQuery.Type,
) {
  const sql = yield* SqlClient.SqlClient;
  const limit = query.limit ?? 20;
  const offset = query.offset ?? 0;

  return yield* withDatabaseTransaction(
    Effect.gen(function* () {
      const type = yield* definition(typeId);
      const from = sql`from content_entries e join content_snapshots p on p.entry_id = e.id and p.kind = 'published' where e.type_id = ${typeId}`;

      // julianday compares instants, including equivalent ISO strings with different offsets/precision.
      const date =
        typeId === "posts"
          ? sql`coalesce(json_extract(p.content_json, '$.fields."publication-date"'), e.first_published_at)`
          : sql`e.first_published_at`;

      const rows = yield* Schema.decodeUnknownEffect(Schema.Array(PublishedRow))(
        yield* sql`select e.id, e.slug, e.first_published_at, p.published_at, p.content_json ${from}
        order by julianday(${date}) desc, e.id asc limit ${limit} offset ${offset}`,
      );

      const counts = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ total: Schema.Int })),
      )(yield* sql`select count(*) as total ${from}`);

      const items = yield* Effect.forEach(rows, (row) => project(type, row));

      return { items, total: counts[0]?.total ?? 0, limit, offset };
    }),
  );
}, storageFailure);
