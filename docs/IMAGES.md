# Private images and managed references

Step 6 adds the private image library and transactional reference protection. Step 7 adds [publication transitions and publication-derived public image access](./PUBLISHING.md). New uploads remain private until referenced by a current publication.

## Uploads and library API

All management/library operations require the current owner cookie session. Binary GET/HEAD can also be authorized by a current published reference, as described below. Writes require the configured exact `Origin` and `x-effect-auth-csrf: 1`, checked before reading the body. See [authentication](./AUTHENTICATION.md).

| Method     | Path                         | Purpose                                            |
| ---------- | ---------------------------- | -------------------------------------------------- |
| POST       | `/api/admin/images`          | Upload **raw file bytes**, not multipart/form-data |
| GET        | `/api/admin/images`          | Private paginated library (`limit`, `offset`)      |
| GET        | `/api/admin/images/:imageId` | Private metadata                                   |
| DELETE     | `/api/admin/images/:imageId` | Permanent deletion, or retry interrupted cleanup   |
| GET / HEAD | `/api/images/:imageId`       | Access-checked original image bytes                |

For example, after signing in and storing the session cookie in `owner.cookies`:

```sh
curl --cookie owner.cookies \
  -H 'Origin: https://cms.example.invalid' \
  -H 'x-effect-auth-csrf: 1' \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @photo.jpg \
  https://cms.example.invalid/api/admin/images
```

Successful uploads/metadata reads return HTTP 200 with `{ id, mediaType, bytes, width, height, createdAt, state, url }`. Original filenames, filesystem paths, and mutable global alt text are not stored or returned. Library pages return `{ items, total, limit, offset }`, newest creation time first, then ID ascending. Defaults are 20/0; limits are integers 1–100 and offsets 0–1,000,000. Tombstones with `state: "deleting"` remain listed so the owner can retry cleanup. Deletion returns `{ "deleted": "<image UUID>" }`.

Only JPEG, PNG, WebP, and GIF are accepted, with an actual encoded-byte limit of **10 MiB**, including streaming bodies without a trustworthy Content-Length. Sharp 0.35.5/libvips determines the format and fully decodes the image, rejecting forged headers, unsupported formats (including SVG), truncated/corrupt payloads, and unsafe decoder workloads. Original bytes are retained; no transformation or replacement endpoint exists. Claimed MIME types and filenames do not determine acceptance or storage names.

Protective decode limits are 16,777,216 total frame pixels and a five-second native processing timeout. The router admits at most two concurrent upload/body-reader workflows, rejects excess admission with 429 instead of queueing, and imposes a 30-second overall upload timeout. Native decoding is awaited even on cancellation so permits are not recycled while native work continues. These bounds are per server/router instance, not distributed limits. The upload buffer is bounded to 10 MiB per admitted upload; native decoding uses additional bounded pixel memory.

Expected failures are 400 (`ImageInvalid`), 413 (`ImageTooLarge`), 404 (`ImageNotFound`), 409 (`ImageInUse` with referencing entry IDs and draft/published kinds), 429 (`ImageBusy`), and opaque 503 (`ImageUnavailable`). Missing owner authority and rejected Origin/CSRF requests return 401/403. The client must not automatically retry uploads after an uncertain network result; inspect the library first.

## Storage, access, and caching

`UPLOADS_PATH` is the persistent image directory. Its parent storage locations must be operator-controlled, outside web/public/static directories. Uploads create this directory if needed with private permissions, and create exclusive, generated `<UUID>.blob` files with mode 0600. Reads open only generated paths with `O_NOFOLLOW`, check for regular files and expected lengths, and never resolve original filenames. File bytes and metadata are immutable.

No directory is mounted as static content. The development Vite `/@fs` allow list is restricted to web source, shared packages, and dependencies, excluding the API's default storage paths. Custom storage must likewise stay outside those served directories. Never expose the image directory directly through a reverse proxy or an independent file server.

Every binary GET/HEAD checks active metadata and current published references; if no publication grants access, it requires current owner admission. This includes requests with If-None-Match, If-Modified-Since, or Range. The current implementation ignores those conditional/range hints, returns a full 200 (empty body for HEAD), and never emits a reusable 304. Responses use `Cache-Control: no-store`; binary responses also set the verified Content-Type, `nosniff`, and a restrictive CSP. New uploads are unavailable anonymously until referenced by a current published snapshot. Unpublish/republish revoke access when the final published reference is removed; draft references alone do not grant public access. Public authorization and the file read share one transaction. Already-downloaded files and independently cached copies cannot be recalled.

## Managed references

Image fields save `{ "imageId": "<UUID>", "alt": "Snapshot-specific description" }`. Markdown uses the stable destination returned by the API:

```md
![Snapshot-specific description](/api/images/<image UUID>)
```

Use the exact canonical destination: no query strings, encoded path aliases, relative-path spellings, or absolute URLs for the reserved `/api/images` path. These are rejected rather than treated as untracked external images. Consuming sites will need to resolve these managed destinations against the CMS origin when rendering Markdown. Non-managed external image destinations are not added to the managed library or reference index.

`extractImageReferences` parses CommonMark with mdast, including inline images, nested images, and resolved full/collapsed/shortcut reference-style image nodes. It covers **every configured Markdown field**, not just built-in `body`. Image fields contribute their IDs directly. References are deduplicated per entry/snapshot. Code spans/fences, ordinary links, unused definitions, raw HTML, and plain-text fields are not Markdown image uses. This is reference extraction, not HTML rendering or sanitization; the admin's separate [safe preview](./CONTENT_EDITING.md#markdown-and-managed-images) does not render arbitrary HTML.

Draft creation and saving validate that every referenced image is active and has its expected regular file. Saving the draft and replacing its reference set share the same SQLite write transaction, including revision/slug updates. Validation or a late write failure rolls everything back. Removing a saved draft use releases only that draft's reference, never the current published snapshot's reference or alt text.

`content_image_references` has foreign keys to the exact entry/snapshot and image, deletion restrictions, and active-image admission triggers. Snapshot/entry deletion cascades its references. Startup adoption rebuilds reference sets from validated snapshots without modifying authored fields or applying defaults. Explicit content data migrations validate and replace both draft/published reference sets transactionally, rolling back definitions, snapshots, revisions, and the migration journal if a referenced image is missing. Use the correct `UPLOADS_PATH` for operator commands as well as the server. Existing snapshots containing missing/invalid managed references now fail adoption instead of being silently accepted.

[Publish](./PUBLISHING.md) uses the same `replaceImageReferences` seam, validating and replacing the published reference set in the publication transaction. Unpublish removes those exact references through snapshot deletion; saved draft references remain intact.

## Partial failures and recovery

An upload writes and syncs a new exclusive file **before** committing metadata. Scoped cleanup removes the file on failure/cancellation before commit; commit and ownership transfer cannot be split by interruption. Interrupted body reads create no file. A successful metadata commit is durable even if the client disconnects before receiving its response.

Deletion first checks both saved draft and published references and reserves the image as `deleting` in a SQLite transaction. This blocks subsequent saves from acquiring a reference before unlinking. It then removes the file and deletes metadata. A failed unlink, interruption, or late database failure leaves a tombstone: it cannot be served or referenced, and DELETE of the same ID resumes cleanup after restart. A missing file is safe on retry. Once fully deleted, another DELETE returns 404. A save/delete race on separate connections either commits a valid reference and rejects deletion, or reserves deletion and rejects the save; it cannot commit a reference to the removed file.

SQLite and the filesystem are not one atomic storage system. Process death between file creation and metadata commit, or an OS error preventing cleanup, can leave an **unregistered private orphan**, never a public file or a committed reference. There is no automatic orphan collector. Inspect/reconcile such files only during maintenance with matching database/configuration backups; never delete files backing active metadata or saved references. See [tested stopped-volume backup/restore](./DEPLOYMENT.md#maintenance-window-backup) and [container/browser verification](./VERIFICATION.md). Hardware power-loss durability is not established by those checks.

## Verification

`apps/api/src/image-http.test.ts` uses real owner authentication, production migrations, temporary on-disk SQLite and files, and real native decoders. It covers formats/original bytes, size boundaries, malformed files/decode bounds, authentication/Origin/CSRF, GET/HEAD/conditional privacy, library pagination/restarts, missing/custom Markdown references, published alt/reference isolation, injected upload/reference/deletion failures, symlink denial, tombstone retries, explicit migration rollback, startup reference rebuilding, separate-connection save/delete races, and cancelled/concurrent upload streams. `packages/shared/src/image-references.test.ts` covers CommonMark extraction and reserved destination validation. These router tests alone do not claim browser/proxy coverage; the separate [v1 acceptance workflow](./VERIFICATION.md) verifies those boundaries.
