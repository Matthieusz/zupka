# Publication transitions and image visibility

Step 7 adds explicit publication operations and publication-derived public image reads. See the implemented [public API/CORS](./PUBLIC_CONTENT_API.md) and [admin editor](./CONTENT_EDITING.md).

## Operations

Both owner-only endpoints require the current session, exact configured Origin, and `x-effect-auth-csrf: 1`, just like other management writes:

| Method | Path                                            | JSON body           |
| ------ | ----------------------------------------------- | ------------------- |
| POST   | `/api/admin/entries/:typeId/:entryId/publish`   | `{ "revision": 3 }` |
| POST   | `/api/admin/entries/:typeId/:entryId/unpublish` | `{ "revision": 4 }` |

Responses are HTTP 200 with the private `AdminEntry` DTO, including the new revision, independent draft/publication snapshots, immutable `firstPublishedAt`, and derived publication state. They use `Cache-Control: no-store`. Failure statuses follow [draft management](./DRAFT_MANAGEMENT.md): 400 invalid content/references, 401/403 rejected authority/admission, 404 unknown type/entry, 409 stale revision, and opaque 503 storage unavailability.

Publish always reads the **saved draft** inside its transaction. It does not accept an unsaved editor version as publication content. Save first, then publish the revision returned by Save. Publishing rebuilds the publication schema from accepted definitions, requires every configured required field, revalidates managed images/files, and atomically replaces the current publication and its image-reference set. Defaults are not reapplied.

The first successful publish sets `firstPublishedAt` once and permanently locks the slug. Republish replaces content and updates `publishedAt`, but never resets first-publication history. Unpublishing does not unlock a slug, even after restart. Saving a draft changes neither the published version nor its alt text/image references. Editing a title never regenerates its slug.

Unpublish removes only the current publication and its image references. It preserves the complete working draft and first-publication history. Entries must still be unpublished before permanent deletion; saved drafts continue protecting their images from deletion.

Save, publish, and unpublish each advance the **same entry revision**, including no-op saves, republishing identical content, and unpublishing an already-unpublished entry. Publish/unpublish update the last-modified timestamp used by admin lists, not public first-publication ordering. A stale revision conflicts rather than overwriting a concurrent save/transition. After a failed or uncertain network response, re-read and reconcile deliberately; do not automatically retry mutations or auto-merge editor state.

## States

State is derived from actual content, never a stored status flag:

- `unpublished`: no current publication, regardless of history.
- `published`: the working draft equals current published content.
- `published-with-draft-changes`: both exist and their content differs.

Object-key order is immaterial; field presence, values, and array order matter. Reverting a draft to published content returns it to `published` without republishing. Unpublishing always returns it to `unpublished` without losing the draft.

## Public and private image access

`GET` and `HEAD /api/images/:imageId` allow anonymous access **only while** the image is active and referenced by at least one current published snapshot. Public access is an existence query over current snapshot references, not a mutable global visibility flag or first-publication history. Shared images remain public until their last current published reference is removed.

A saved draft alone never grants public access. Saving changes does not remove access to images in the existing published version. Republish can make new images public and removed images private together. Unpublish removes that entry's public references; an image remains public if another published entry still references it. Alt text remains part of each individual snapshot's image/Markdown use, never mutable upload metadata.

If no publication grants access, the handler falls back to the same durable `OwnerGuard` used by `ownerRoutes`. Private images and unknown IDs require current owner admission; anonymous private reads return 401, and a foreign Origin cannot use owner cookies to fetch private content. Authenticated owners can still read their saved-draft images after unpublishing. Management entry/image metadata routes always require the owner, even when an image's bytes are public.

Public image reads do not rely on cookies or the admin Origin. Separate sites can embed published images; this does not enable credentialed management CORS. See the separate [public API CORS policy](./PUBLIC_CONTENT_API.md#public-only-cors). There is still no static image-directory mount.

## Atomicity, races, and caching

Entry metadata, current published snapshots, and publication image references commit in one SQLite write transaction. Failure—including missing files or a late reference/snapshot write failure—rolls them all back. A failed first publication leaves the slug editable and history unset. Unpublish removes its exact references through snapshot foreign-key cascading in the same transaction.

Revision predicates and SQLite writer serialization guard competing saves, transitions, and entry deletion. Image deletion checks both draft and published references and reserves a non-referenceable tombstone before unlinking. Publication cannot acquire a reference to a deleting/missing image. Incompatible definition adoption fails transactionally rather than racing a publication into a half-adopted schema.

Public image authorization, metadata decoding, and the bounded file read share a transaction, so they observe one consistent publication/reference state and serialize with visibility/deletion changes. Native SQLite busy waits are disabled: they otherwise block the Node event loop while another local transaction awaits a filesystem check. Content transactions instead retry only rolled-back lock failures cooperatively at 10 ms intervals, at most 100 retries. Revision/validation errors, other SQL failures, and committed mutations are not retried. Exhaustion remains an unavailable storage response. This is local lock coordination, not distributed deployment support; the supported deployment is still one service with one shared connection. Run explicit content conversions only during maintenance with the server stopped.

All binary success/denial/error paths use `Cache-Control: no-store`. Conditional and Range hints do not bypass the current access check: the current handler ignores them, returns a full 200 for allowed reads (empty body for HEAD), and never returns a reusable 304. Do not override this at a reverse proxy/CDN.

A request authorized before a visibility-changing commit can finish delivering its already-read bytes. New reads after that commit must pass the new visibility check. Previously downloaded images, independently cached portfolio pages, or copies held by third parties **cannot be recalled**. No cache invalidation/rebuild integration is claimed.

## Verification

`apps/api/src/publication-http.test.ts` exercises real authenticated routers, production migrations, temporary SQLite/files, and native image uploads. It covers the full draft → publish → edit/save → republish → unpublish flow, history/slug locking across restart, state derivation/reversion, incomplete required fields, custom Markdown, saved-file revalidation, shared/removed/public/private images, HEAD/conditional privacy, late failure rollback, stale/overlapping commands, separate-connection deletion races, and incompatible configuration adoption. The concurrency tests also reproduce and guard against synchronous SQLite busy-wait starvation without increasing timeouts. Existing owner-security, draft, and image tests remain in place.

Public delivery/ordering/CORS are documented in the [public API guide](./PUBLIC_CONTENT_API.md).
The [v1 verification record](./VERIFICATION.md) adds real HTTPS browser and
container/operator evidence without extending the claims of these router tests.
