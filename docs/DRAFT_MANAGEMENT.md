# Draft-management API

Step 5 adds private draft-management routes. Step 7 adds [publication transitions](./PUBLISHING.md) through the same cohesive entry module. The [admin editor](./CONTENT_EDITING.md) and [public API](./PUBLIC_CONTENT_API.md) are also implemented. Contracts are in `packages/contracts/src/entries.ts`; the cohesive entry module is `apps/api/src/entries.ts`.

## Authentication

All routes below use `ownerRoutes`: a current owner cookie session is required. Writes also require the configured exact `Origin` and `x-effect-auth-csrf: 1`. Responses use `Cache-Control: no-store`. See [authentication](./AUTHENTICATION.md) for sign-in and operator setup.

## Routes

| Method | Path                                  | Request                                                                             |
| ------ | ------------------------------------- | ----------------------------------------------------------------------------------- |
| GET    | `/api/admin/content-types`            | Safe accepted content definitions                                                   |
| GET    | `/api/admin/entries/:typeId`          | Optional `search`, `state`, `limit`, `offset` query parameters                      |
| POST   | `/api/admin/entries/:typeId`          | `{ "title": "Hello", "fields": {} }`; optional explicit `slug`                      |
| GET    | `/api/admin/entries/:typeId/:entryId` | Stable UUID, not slug                                                               |
| PUT    | `/api/admin/entries/:typeId/:entryId` | `{ "revision": 1, "content": { "title": "Hello", "slug": "hello", "fields": {} } }` |
| DELETE | `/api/admin/entries/:typeId/:entryId` | JSON body `{ "revision": 1 }`                                                       |

Successful operations return HTTP 200. Creation, retrieval, and saving return an explicit private DTO containing `id`, `typeId`, `revision`, creation/update timestamps, independent `draft` and nullable `published` snapshots, nullable `firstPublishedAt`, and derived `state`. Delete returns `{ "deleted": "<entry UUID>" }`.

Creation suggests an omitted slug deterministically from the title and applies configured defaults once. Suggestions are not silently suffixed on collision: supply an edited slug and retry creation. Slugs are unique per type. Title edits on save do not regenerate slugs. PUT is a complete draft replacement, not a patch: omitted optional fields are removed, never restored from defaults. Supplied fields always satisfy the configured schemas; required custom fields can be absent in drafts.

[Publish/unpublish](./PUBLISHING.md) are explicit POST actions on `/:entryId/publish` and `/:entryId/unpublish`, each accepting `{ "revision": 1 }` and returning the updated private entry. Publish uses only the saved draft. Saving never changes the published snapshot or its timestamp. Slugs remain locked after first publication, even if currently unpublished. Published entries cannot be deleted.

## Lists

Lists return `{ "items": [...], "total": 0, "limit": 20, "offset": 0 }`. Defaults are limit 20 and offset 0; limits are 1–100 and offsets 0–1,000,000, both integers. Search is a literal substring of the draft title, at most 200 characters; `%` and `_` are not wildcards. SQLite's built-in case folding makes ASCII search case-insensitive; no language-specific Unicode case folding is promised.

Ordering is last-modified timestamp descending, then UUID ascending; saves and publication transitions update this admin timestamp. `total` counts matches before pagination, including when the requested page is empty. List IDs/count and selected snapshots are read in the same transaction. Only the selected page's snapshots are decoded; filtering/counting can scan the selected type's snapshots. Offset pagination is not a frozen snapshot across separate requests: intervening saves can move entries between pages.

States are derived from current snapshots, never stored flags:

- `unpublished`: no current published snapshot, regardless of publication history.
- `published`: working draft and published content match.
- `published-with-draft-changes`: a current published snapshot exists and content differs.

Object-key order is immaterial; array order, field presence, and values matter.

## Failures and concurrency

- 400: malformed input, configured-field validation failure (`EntryInvalid`), or unavailable/malformed managed-image references (`InvalidImageReference`; transport schema failures use Effect's schema-error response).
- 401/403: missing authority or rejected Origin/CSRF admission.
- 404: missing content type, missing entry, or mismatched type/entry pair (`EntryNotFound`).
- 409: `EntryError` with `reason` equal to `slug-taken`, `stale-revision`, `slug-locked`, or `published-entry`.
- 503: opaque `EntryUnavailable`, without SQL, filesystem paths, or authored content.

Every successful save, publish, or unpublish increments the revision, including no-op operations. Save, delete, publish, and unpublish require the revision returned by the last read/save. A stale revision conflicts rather than merging or overwriting. Re-read and deliberately reconcile user input; do not automatically retry mutations. Creation is not idempotent: after an uncertain network outcome, inspect the list before retrying.

SQLite `BEGIN IMMEDIATE` transactions serialize writers across connections. Revision predicates also guard the authoritative update/delete, and uniqueness remains backed by the existing database constraint. A failed late snapshot write rolls back metadata, slug, timestamp, and revision together. Publish/unpublish now check and increment this same revision in their transactions, committing snapshot/reference changes together.

## Verification and remaining scope

`apps/api/src/entry-http.test.ts` exercises real owner authentication, production migrations, temporary on-disk SQLite databases, router restarts, field/default/date parsing, literal search/pagination/status filters, duplicate slugs, anonymous/Origin/CSRF rejection, competing writers on separate connections, stale deletion, and rollback after an injected late database failure. These draft-slice tests retain seeded publication fixtures. `apps/api/src/publication-http.test.ts` exercises the actual publish/unpublish routes and their image visibility transitions.

Step 6 now adds [managed-image existence/reference rules](./IMAGES.md) to draft creation/saving, with reference sets committed alongside snapshots and revisions. Step 7 now implements [publication and image visibility](./PUBLISHING.md). The existing demo/login UI is unchanged; entry lists and generated editors follow in steps 9–10.
