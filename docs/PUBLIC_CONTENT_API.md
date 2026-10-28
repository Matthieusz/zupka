# Public content API

Anonymous REST/JSON reads are implemented in `apps/api/src/public-content.ts` and
`public-content-http.ts`. Shared schemas and the Effect HttpApi contract live in
`packages/contracts/src/public-content.ts` (`PublicContentApi`, `PublicEntry`,
`PublicContentPage`). No API key, cookie, or owner session is needed.

## Routes and payloads

| Method     | Route                        | Result                                |
| ---------- | ---------------------------- | ------------------------------------- |
| GET / HEAD | `/api/content/:typeId`       | Paginated current publications        |
| GET / HEAD | `/api/content/:typeId/:slug` | One current publication               |
| OPTIONS    | Either route                 | Credential-free public-read preflight |

Lists accept `limit` (integer 1–100, default 20) and `offset` (integer
0–1,000,000, default 0). They return `{ items, total, limit, offset }`. An offset
past the end returns an empty `items` array with the actual total. There is no
public search, publication-state filter, arbitrary field query, or write endpoint.

Each item/detail response is an explicit projection, for example:

```json
{
  "id": "195bb674-7581-4777-868e-77860a08b472",
  "typeId": "posts",
  "title": "A published post",
  "slug": "a-published-post",
  "firstPublishedAt": "2026-01-01T12:00:00.000Z",
  "publishedAt": "2026-01-02T12:00:00.000Z",
  "fields": {
    "summary": "A short introduction",
    "body": "Markdown **source** with ![Example](/api/images/572a8385-7c7c-4721-8057-49a5723a4f90)",
    "cover-image": {
      "url": "/api/images/572a8385-7c7c-4721-8057-49a5723a4f90",
      "alt": "Example"
    },
    "tags": ["Effect"]
  }
}
```

Only supplied published fields are returned; missing optional fields stay absent.
Custom types/fields use the same format. Strings (including Markdown), numbers,
booleans, dates, URLs, select values, and text lists retain their authored values
(with configured date normalization). Image fields become `{ url, alt }`, never
upload/storage metadata. No draft, editing revision, state, created/updated time,
filesystem path, or owner data is serialized. Even an authenticated caller gets
only the published version from these routes.

Image URLs and canonical managed Markdown destinations are **root-relative to the
CMS origin**, not the portfolio origin. Resolve them against the CMS base URL when
rendering on another site. Markdown source is not rewritten or rendered by the
CMS; consuming sites own rendering, sanitization, and link/image URL resolution.
A normal image element can display a public image cross-origin; binary image
routes do not offer a separate credentialed cross-origin private-image API.

```js
const cms = "https://cms.example.com";
const response = await fetch(`${cms}/api/content/posts?limit=10&offset=0`, {
  credentials: "omit",
  cache: "no-store",
});
if (!response.ok) throw new Error(`CMS returned ${response.status}`);
const page = await response.json(); // Decode with PublicContentPage in typed clients.
// For an image-field value: new URL(image.url, cms).href
```

Unknown types, missing slugs, and unpublished entries share `404 EntryNotFound`.
Malformed identifiers, slugs, or pagination return 400. Infrastructure or invalid
stored-publication failures return opaque `503 EntryUnavailable`, never stored
content or SQL diagnostics. Unsupported write methods have no matching route.

## Ordering and publication isolation

- Posts: published `publication-date`, falling back to `firstPublishedAt`.
- Projects and custom types: `firstPublishedAt`, irrespective of custom dates.
- Newest first by instant, then stable entry ID ascending for ties.
- A future supplied Post date is immediately public after publishing; it does not
  schedule publication.
- Editing/saving does not change public values or ordering. Republishing replaces
  the snapshot but preserves first publication; only an explicitly changed Post
  publication date can change its date ordering.
- Lists, totals, and selected publication snapshots are read in one SQLite
  transaction. Public queries never read working drafts.

Offset pages are consistent individually, not a retained cross-request snapshot:
publication changes between page requests can move entries across page boundaries.
Published images use the existing access-checked handlers; see [publication and
image visibility](./PUBLISHING.md). Republish/unpublish commits entry availability
and managed-image references together. A later image request rechecks current
visibility, so an image can legitimately become unavailable after an earlier
content response if the owner unpublishes in between.

## Public-only CORS

`PUBLIC_READ_ORIGINS` is independent of `AUTH_ORIGIN`:

- Default `*`: any portfolio origin can read public content without credentials.
- Or a comma-separated list of exact HTTP(S) origins, for example
  `https://portfolio.example,https://preview.example`.
- Empty values, wildcard lists/subdomains, paths, trailing slashes, and opaque
  origins are rejected at startup. The process environment preserves explicit
  empty values so they cannot silently broaden access to `*`.

Public responses include `Access-Control-Allow-Origin` only for the wildcard or a
matching origin, `Vary: Origin`, and allowed methods `GET, HEAD, OPTIONS`. They never
include `Access-Control-Allow-Credentials` or allow custom mutation/CSRF headers.
The same policy applies to errors and preflight. HEAD returns the current status
and headers with no body. A nonmatching origin gets no CORS read permission, not
an authentication requirement: this remains public data accessible to non-browser
clients. CORS is not a privacy or authorization mechanism.

This middleware wraps only `/api/content` routes. It does not widen owner origin
trust, authenticate requests, or add CORS permission to auth/admin/private-image
routes. Never add a proxy-wide wildcard credentialed CORS rule.

## Caching and limits of revocation

Content responses, including 400/404/503 errors and HEAD/preflight, use
`Cache-Control: no-store`. Conditional request headers never reuse an old response
or return 304 in place of a current visibility check. Image reads likewise use
`no-store` and current publication references; uploads are never directory-mounted.

Any production static server, reverse proxy, CDN, or service worker **must not
cache `/api/*` responses, override `no-store`, or serve the upload/database paths**.
Forward API requests to the application (including HEAD and conditional requests);
do not serve stale-on-error copies or cached image files. Keep admin/static SPA
fallbacks separate from API routing. See [single-service deployment](./DEPLOYMENT.md)
and [HTTPS browser/container acceptance](./VERIFICATION.md); these are separate
checks, not claims made by the router tests alone.

Independently cached portfolio HTML, build-time content, copied assets, and images
already downloaded by visitors **cannot be recalled**. Consumers own rebuild,
refresh, retention, and purge policies; no rebuild hook is provided. `no-store`
protects cooperating CMS HTTP caches, not copies a consumer deliberately retains.

## Verification

`apps/api/src/public-content-http.test.ts` uses anonymous real-router requests,
actual owner commands/transitions, native image uploads, temporary files/SQLite,
and production migrations. It covers list/detail isolation through publication
changes and restart, image/alt-text visibility, Post backdating/fallback/ties and
bounded pages, Projects/custom types, non-Post ordering, lookup scoping, malformed
requests, corrupt publication projection, CORS configuration/errors/preflight,
and separation from authenticated routes. Existing publication tests retain the
separate-connection transition/reference race coverage.
