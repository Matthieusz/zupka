import { AdminEntry, type PublicationState } from "@zupka/contracts";
import { Schema } from "effect";

/** Synthetic safe definitions returned through the real frontend HTTP transport in tests. */
export const contentTypes = [
  { id: "posts", label: "Posts", fields: [] },
  { id: "projects", label: "Projects", fields: [] },
  { id: "notes", label: "Field notes", fields: [] },
];

/** A schema-valid owner session; contains no real credentials or persisted authority. */
export function ownerSession() {
  const now = Date.now();

  return {
    subjectId: "owner",
    sessionId: "A".repeat(43),
    securityRevision: "test-revision",
    issuedAt: now,
    expiresAt: now + 60_000,
    absoluteExpiresAt: now + 120_000,
    claims: { role: "owner" },
    assurance: { method: "password", factors: ["knowledge"], authenticatedAt: now },
  };
}

/** Creates a parsed management DTO with independent snapshots for the requested state. */
export function exampleEntry(
  title: string,
  state: typeof PublicationState.Type = "unpublished",
  id = "00000000-0000-4000-8000-000000000001",
) {
  const content = { title, slug: "example-entry", fields: {} };
  const date = "2026-10-14T12:00:00.000Z";

  return Schema.decodeUnknownSync(AdminEntry)({
    id,
    typeId: "posts",
    revision: 1,
    createdAt: date,
    updatedAt: date,
    firstPublishedAt: state === "unpublished" ? null : date,
    draft: content,
    published:
      state === "unpublished"
        ? null
        : {
            content:
              state === "published" ? content : { ...content, title: "Previous public title" },
            publishedAt: date,
          },
    state,
  });
}

/** Encodes a Yielded Auth wire fixture, not an application-level tagged value. */
export function authResponse<A>(value: A) {
  return new Response(`{"_tag":"Success","value":${JSON.stringify(value)}}`, {
    headers: { "content-type": "application/json" },
  });
}

/** Produces a page-shaped fixture; production client schemas still decode it on receipt. */
export function entryPage(
  items: ReadonlyArray<typeof AdminEntry.Type>,
  offset = 0,
  total = items.length,
) {
  return { items, total, limit: 20, offset };
}
