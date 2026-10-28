import { ContentTypeId, DateTime, EntryId, Slug, Title } from "@zupka/shared";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { EntryListQuery, EntryNotFound, EntryUnavailable } from "./entries.js";

/** Public image use; resolve the root-relative URL against the CMS origin, not the consuming site. */
export const PublicImage = Schema.Struct({ url: Schema.String, alt: Schema.String });

/** Published field values only; Markdown remains source and image identities become fetchable URLs. */
export const PublicFieldValue = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Boolean,
  PublicImage,
  Schema.Array(Schema.String),
]);

/** Explicit publication projection, excluding revisions, working drafts and management metadata. */
export const PublicEntry = Schema.Struct({
  id: EntryId,
  typeId: ContentTypeId,
  title: Title,
  slug: Slug,
  firstPublishedAt: DateTime,
  publishedAt: DateTime,
  fields: Schema.Record(Schema.String, PublicFieldValue),
});

/** Offset pagination, bounded to 1–100 results and at most 1,000,000 skipped entries. */
export const PublicContentQuery = Schema.Struct({
  limit: EntryListQuery.fields.limit,
  offset: EntryListQuery.fields.offset,
});

/** Newest-first publication page with an ascending stable entry-ID tie-breaker. */
export const PublicContentPage = Schema.Struct({
  items: Schema.Array(PublicEntry),
  total: Schema.Int,
  limit: Schema.Int,
  offset: Schema.Int,
});

/** Anonymous read-only content contract. Unknown types and absent/unpublished slugs return the same 404. */
export const PublicContentApi = HttpApi.make("public-content").add(
  HttpApiGroup.make("content")
    .add(
      HttpApiEndpoint.get("list", "/api/content/:typeId", {
        params: { typeId: ContentTypeId },
        query: PublicContentQuery,
        success: PublicContentPage,
        error: [EntryNotFound, EntryUnavailable],
      }),
    )
    .add(
      HttpApiEndpoint.get("get", "/api/content/:typeId/:slug", {
        params: { typeId: ContentTypeId, slug: Slug },
        success: PublicEntry,
        error: [EntryNotFound, EntryUnavailable],
      }),
    ),
);
