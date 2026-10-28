import {
  ContentConfiguration,
  ContentTypeId,
  DateTime,
  DraftData,
  EntryId,
  InvalidImageReference,
  Slug,
  Title,
} from "@zupka/shared";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

/** Optimistic concurrency token, required on every existing-entry mutation. */
export const EntryRevision = DraftData.fields.revision;

/** Derived from current snapshots, never persisted as a status flag. */
export const PublicationState = Schema.Literals([
  "unpublished",
  "published",
  "published-with-draft-changes",
]);

/** Explicit private management projection; never use this DTO for public delivery. */
export const AdminEntry = Schema.Struct({
  id: EntryId,
  typeId: ContentTypeId,
  revision: EntryRevision,
  createdAt: DateTime,
  updatedAt: DateTime,
  firstPublishedAt: Schema.NullOr(DateTime),
  draft: DraftData.fields.content,
  published: Schema.NullOr(
    Schema.Struct({ content: DraftData.fields.content, publishedAt: DateTime }),
  ),
  state: PublicationState,
});

/** Creation alone suggests a missing slug and applies configured field defaults. */
export const CreateEntry = Schema.Struct({
  title: Title,
  slug: Schema.optionalKey(Slug),
  fields: Schema.optionalKey(DraftData.fields.content.fields.fields),
});

/** Publish/unpublish act only on the saved revision, never unsaved client content. */
export const PublicationTransition = Schema.Struct({ revision: EntryRevision });

/** Full replacement of the working draft, not a patch or a publication operation. */
export const SaveEntry = Schema.Struct({
  revision: EntryRevision,
  content: DraftData.fields.content,
});

/** Bounded list request; Defaults are applied by the entry module. Search is a literal title substring. */
export const EntryListQuery = Schema.Struct({
  search: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  state: Schema.optionalKey(PublicationState),
  limit: Schema.optionalKey(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })),
  ),
  offset: Schema.optionalKey(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: 1_000_000 }),
    ),
  ),
});

/** Stable, paginated management results ordered by last save, then entry ID. */
export const EntryPage = Schema.Struct({
  items: Schema.Array(AdminEntry),
  total: Schema.Int,
  limit: Schema.Int,
  offset: Schema.Int,
});

/** Safe expected management failure; authored values and infrastructure causes are never exposed. */
export class EntryError extends Schema.TaggedError<EntryError, { readonly brand: unique symbol }>()(
  "EntryError",
  {
    reason: Schema.Literals(["slug-taken", "stale-revision", "slug-locked", "published-entry"]),
  },
  { httpApiStatus: 409 },
) {}

/** Missing type or entry; the same response is used for a mismatched type/entry pair. */
export class EntryNotFound extends Schema.TaggedError<
  EntryNotFound,
  { readonly brand: unique symbol }
>()("EntryNotFound", {}, { httpApiStatus: 404 }) {}

/** Supplied draft or saved publication content does not satisfy its configured schema. */
export class EntryInvalid extends Schema.TaggedError<
  EntryInvalid,
  { readonly brand: unique symbol }
>()("EntryInvalid", {}, { httpApiStatus: 400 }) {}

/** Infrastructure failure projection without SQL, filesystem paths, or authored values. */
export class EntryUnavailable extends Schema.TaggedError<
  EntryUnavailable,
  { readonly brand: unique symbol }
>()("EntryUnavailable", {}, { httpApiStatus: 503 }) {}

const typeParams = { typeId: ContentTypeId };

const entryParams = { ...typeParams, entryId: EntryId };

const errors = [
  EntryError,
  EntryNotFound,
  EntryInvalid,
  EntryUnavailable,
  InvalidImageReference.annotate({ httpApiStatus: 400 }),
];

/** Owner-only HTTP contract, mounted behind ownerRoutes by the server. */
export const EntriesApi = HttpApi.make("entries").add(
  HttpApiGroup.make("entries")
    .add(
      HttpApiEndpoint.get("types", "/api/admin/content-types", {
        success: ContentConfiguration,
        error: EntryUnavailable,
      }),
    )
    .add(
      HttpApiEndpoint.get("list", "/api/admin/entries/:typeId", {
        params: typeParams,
        query: EntryListQuery,
        success: EntryPage,
        error: errors,
      }),
    )
    .add(
      HttpApiEndpoint.post("create", "/api/admin/entries/:typeId", {
        params: typeParams,
        payload: CreateEntry,
        success: AdminEntry,
        error: errors,
      }),
    )
    .add(
      HttpApiEndpoint.get("get", "/api/admin/entries/:typeId/:entryId", {
        params: entryParams,
        success: AdminEntry,
        error: errors,
      }),
    )
    .add(
      HttpApiEndpoint.put("save", "/api/admin/entries/:typeId/:entryId", {
        params: entryParams,
        payload: SaveEntry,
        success: AdminEntry,
        error: errors,
      }),
    )
    .add(
      HttpApiEndpoint.post("publish", "/api/admin/entries/:typeId/:entryId/publish", {
        params: entryParams,
        payload: PublicationTransition,
        success: AdminEntry,
        error: errors,
      }),
    )
    .add(
      HttpApiEndpoint.post("unpublish", "/api/admin/entries/:typeId/:entryId/unpublish", {
        params: entryParams,
        payload: PublicationTransition,
        success: AdminEntry,
        error: errors,
      }),
    )
    .add(
      HttpApiEndpoint.delete("delete", "/api/admin/entries/:typeId/:entryId", {
        params: entryParams,
        payload: Schema.Struct({ revision: EntryRevision }),
        success: Schema.Struct({ deleted: EntryId }),
        error: errors,
      }),
    ),
);
