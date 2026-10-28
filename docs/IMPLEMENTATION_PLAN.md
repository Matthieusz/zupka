# CMS v1 implementation plan

Status: task 1 integration demonstrated. Steps 2–10 content schemas, typed configuration, SQLite storage, compatibility/migration checks, owner authentication/security, authenticated draft management, private uploads/managed-image references, publication/image visibility transitions, the public content API, admin shell/entry lists, generated editors, and image-management screens are implemented. Step 11 single-service production packaging and maintenance-window backup/restore are implemented and container-verified. Step 12 verification tooling and operator documentation are implemented for the tested Linux/Chromium/container environment. Release acceptance remains blocked by a reproduced, unresolved pre-existing intermittent authenticated 401; see [verification](./VERIFICATION.md#limits-and-operator-acceptance) for the evidence and platform/deployed-host limits.

The approved [specification](./SPEC.md) defines scope. [GLOSSARY.md](../GLOSSARY.md) defines terminology; [ROADMAP.md](./ROADMAP.md) contains future work, not v1 requirements. Complete the steps in order and add verification alongside each slice rather than postponing tests until the end.

## Starting point

The inspected scaffold already provides:

- An Effect 4.0.6 HTTP backend with a health endpoint and real-router tests.
- Shared Effect Schema/HttpApi contracts in `packages/contracts`.
- A Svelte 5 SPA with Bits UI, Tailwind, TanStack Query, and an abort-aware Effect-to-Promise bridge.
- Vite+ build, test, lint, formatting, and type-check commands.
- An intentionally empty `packages/shared` package.

The original scaffold did not provide persistence, authentication, CMS features, or production static-file serving. The task 1 verification slice now adds owner authentication and SQLite-backed sessions, but not CMS features or production static-file serving. Preserve existing working-tree changes; do not reset or replace them as part of implementation.

## Implementation shape

Use the existing workspace; do not introduce a plugin system or another application framework.

- `packages/shared`: concrete, browser-safe content definitions, domain schemas, field-schema construction, and pure domain rules. Add its Effect dependency when it gains real code.
- `packages/contracts`: explicit admin/public DTOs, typed errors, and HTTP contracts composed from shared schemas.
- `apps/api`: the typed content configuration, cohesive content/auth/image modules, SQLite/filesystem adapters, CLI entry, and runtime composition.
- `apps/web`: admin screens, generated field editors, and schema-decoding clients using the existing Query/Effect integration.

These are responsibility assignments, not a requirement to create every file or abstraction up front. Keep runtime configuration, credentials, filesystem paths, and persistence implementations out of browser imports. The admin receives a schema-validated, safe description of configured content types rather than importing server configuration.

## 1. Establish the baseline and verify dependency compatibility

Baseline on Node 26.12.1 / pnpm 12.14.0: `pnpm check` and `pnpm build` passed before changes (10 tests passed). `@yielded/auth` and `@yielded/auth-persistence` 0.1.0-beta.46 declare Effect `^4.0.3`; `@effect/sql-sqlite-node` 4.0.6 declares Effect `^4.0.6`. These versions are pinned. `apps/api/src/auth-sqlite.test.ts` demonstrates password hashing, SQLite-backed sign-in, stateful session verification, and invalidation after an authority revision change. `apps/api/src/auth-http.test.ts` exercises the production migrations and temporary on-disk SQLite database, local owner creation/recovery, cookie-session persistence across router restarts, rejected credentials/origins, logout, absent signup/reset routes, and direct Effect HTTP client calls without React. The registry's `latest` tags for the Yielded packages point to older beta releases; do not select them implicitly.

**Verified local operator path:** the application owns provisioning and recovery through its mapped SQLite tables; it does not use public registration or email reset proofs. Creation hashes with Yielded Auth, writes the identifier/credential/password records atomically, and enforces one owner with a database constraint. Recovery replaces the password hash and credential/security revisions and deletes sessions atomically. The real-router tests verify that this invalidates old passwords and sessions. Hidden create/recover prompts were exercised in a real pseudo-terminal without echoing passwords. The minimal Svelte form uses the direct schema-decoding Effect client, with loading/error/logout states. See [manual verification](../README.md#verify-owner-login-locally). This does not mark the broader authentication/security, admin, or deployment tasks complete.

- Run `pnpm check` and `pnpm build`; record pre-existing failures before editing code.
- Verify and pin a released Yielded Auth version compatible with the installed Effect and Node versions. The beta version noted in the spec is an inspection result, not an instruction to install it blindly.
- Verify the Effect SQL SQLite driver and Yielded Auth persistence adapter can share the intended SQLite setup on Node 26.
- Establish a small executable integration test for password sign-in, a stateful session, and the direct Effect HTTP client without React.
- Confirm supported owner provisioning and operator-driven password recovery mechanisms. Do not assume public registration or emailed reset flows are suitable for the CLI.

**Done when:** the scaffold baseline is understood, the chosen dependency versions build, and the auth/persistence integration is demonstrated. Resolve or report a blocker here before building the CMS on an unverified auth integration; do not silently substitute another auth library.

## 2. Define the content model and code configuration

Implemented in `packages/shared/src/content.ts` and `apps/api/src/content-config.ts`; see [configuration usage](./CONTENT_CONFIGURATION.md). Shared tests cover every field kind, malformed configuration, draft/publication requirements, creation-only defaults, deterministic slugs/date normalization, and JSON description round-tripping with schema rebuilding. API configuration tests cover Posts, Projects, and custom fields/types. The API startup decodes the configured definitions; no content persistence, routes, or admin editor are claimed by this step. Verification: `pnpm check` passed (35 tests, including 21 new content/configuration tests), `pnpm build` passed, and `git diff --check` passed.

- Define Effect Schemas for entry/type/image identifiers, slugs, field definitions, values, draft/publication data, and expected domain errors.
- Implement the agreed field palette: text, number, boolean, date/time, URL, Markdown, image, fixed-choice select, and text lists.
- Provide typed Posts and Projects definitions and a small example of a custom content type and custom fields.
- Require title and slug for every type; reject duplicate type/field identifiers, reserved-field collisions, and invalid defaults or select definitions.
- Build draft and publish schemas from the same definitions. Drafts may omit required custom fields but must validate supplied values; published entries must satisfy all requirements.
- Apply defaults only on entry creation. Keep date normalization and slug suggestions deterministic.
- Expose a safe, serializable content-type description and rebuild the same field schemas in the admin from that description.

**Done when:** schema tests cover every field kind, malformed configuration, incomplete drafts, publish validation, and defaults without unchecked casts or duplicate hand-written validators.

## 3. Add SQLite persistence and schema compatibility checks

Implemented in `apps/api/src/database.ts`, `content-storage.ts`, and `storage.ts`; see [storage and migration operations](./CONTENT_STORAGE.md). Auth routes and operator commands share the scoped database layer. Startup runs versioned auth/content DDL and transactionally adopts only compatible definitions. Entries retain independent draft/published JSON snapshots and immutable first-publication history, with database identity/slug constraints. Explicit versioned conversions are local-only via `content:migrate`; startup never runs them automatically. Temporary on-disk database tests cover restart persistence, an existing owner-only database, safe additions without backfilling defaults, incompatible-change rejection, constraints, and migration validation/rollback. This step does not implement management routes, publishing transitions, or image-reference rules. Verification: `pnpm check` passed (48 tests, including 13 new persistence/command tests), `pnpm build` passed, and `git diff --check` passed.

- Introduce one scoped database layer, versioned SQL migrations, and validated runtime storage configuration.
- Store stable entry identity and indexed metadata separately from schema-validated draft/published field snapshots. JSON snapshots are the initial approach; v1 does not need arbitrary custom-field query indexes.
- Preserve first-publication metadata independently of current public availability so unpublishing cannot unlock a slug or reset its history.
- Add database constraints for applicable invariants, including per-type slug uniqueness.
- Persist the accepted content definitions needed to detect incompatible configuration changes. Compare proposed definitions and validate existing drafts/published versions before adopting changes.
- Permit safe additions without rewriting old content or applying new defaults to it. Reject incompatible changes with actionable errors.
- Provide an explicit, versioned data-migration path using the same schemas and transaction rules, not an automatic conversion engine.
- Use real temporary SQLite databases and the production migration path in persistence tests.

**Done when:** data survives restart, migrations work on fresh and existing fixtures, safe configuration changes preserve content, and incompatible changes fail without modifying it.

## 4. Implement owner authentication and CLI operations

Implemented in `apps/api/src/auth.ts`, `owner-http.ts`, and `owner.ts`; see [owner authentication and security](./AUTHENTICATION.md). Only sign-in/session/logout are mounted. Production requires an explicit HTTPS origin and uses Secure host-only SameSite=Strict cookies; protected route groups enforce current owner authority for GET/HEAD and Origin/CSRF admission before custom writes, including multipart handlers. Explicit password attempt budgets and native KDF admission bound sign-in work. Recovery updates credentials/security revisions and deletes all sessions atomically; tests also inject a late database failure to verify rollback. Hidden create/recover prompts and duplicate-owner rejection were reverified in a real pseudo-terminal without echoing passwords. `ownerRoutes` is the required seam for subsequent management/upload/private-image routes; this step does not ship those CMS routes. Rate limits are process-local, not a distributed/durable limiter. Verification: `pnpm check` passed (59 tests, including 11 new security tests), `pnpm build` passed, and `git diff --check` passed. Browser/reverse-proxy/container verification remains later work.

- Compose Yielded Auth password authentication and durable stateful sessions with the database layer.
- Mount only the required sign-in/session/logout operations; do not expose public signup, setup, or email recovery endpoints.
- Provide local CLI commands for owner creation and password recovery, with hidden interactive password prompts and a single-owner invariant.
- Ensure password recovery invalidates existing authority/sessions using the verified Yielded Auth integration.
- Use secure production cookie settings, explicit trusted origins, CSRF protections, bounded password work, and sign-in rate limiting. Keep secrets and passwords out of logs and errors.
- Make authentication/owner authorization mandatory for all subsequent management routes, including upload and private-image access.

**Done when:** real HTTP tests demonstrate sign-in, rejection, logout, session invalidation after recovery, and anonymous denial. Provisioning a second owner is rejected, and no public account-creation route exists.

## 5. Deliver the draft-management slice

Implemented in `apps/api/src/entries.ts`, `entry-http.ts`, and `packages/contracts/src/entries.ts`; see [draft-management API](./DRAFT_MANAGEMENT.md). Owner-only routes expose safe configured definitions and entry creation/retrieval/list/save/delete. Lists provide literal title search, bounded pagination, stable ordering, and snapshot-derived publication filters. Creation alone applies defaults and suggests an editable slug; database constraints enforce per-type uniqueness and historical slug locking. Save/delete check the shared revision inside SQLite write transactions, with conditional writes preventing stale overwrite. Saves replace only the working draft; published entries cannot be deleted. Real-router tests use production migrations, temporary on-disk databases, restarts, separate writer connections, and an injected late snapshot failure to verify rollback. Publications are seeded only for isolation/filter/slug/deletion tests; publishing, managed-image checks, and admin screens remain later steps. Verification: `pnpm check` passed (67 tests, including 8 new draft-management router tests), `pnpm build` passed, and `git diff --check` passed. The pre-edit baseline had one timeout in the existing owner rate-limit test; the final complete run passed without changing that test or its timeout.

- Implement authenticated entry creation, retrieval, listing, saving, and deletion through a cohesive entry module and thin HTTP handlers.
- Support per-type title search, pagination, and the publication-state filters required by the admin.
- Suggest editable initial slugs; enforce title/slug requirements and uniqueness through both domain parsing and database constraints.
- Preserve the distinction between a working draft and a published version. Saving never mutates the published snapshot.
- Guard concurrent writes so an old editor tab or an overlapping transition cannot silently overwrite newer state. Surface a conflict rather than auto-merging.
- Reject deletion of published entries; leave destructive UI confirmation to the admin step.

**Done when:** an authenticated caller can manage text-only drafts, invalid values and duplicate slugs are rejected, stale saves conflict, and another public version cannot be changed by saving a draft.

## 6. Implement private uploads and managed-image references

Implemented in `apps/api/src/images.ts`, `image-storage.ts`, `image-http.ts`, and `packages/shared/src/image-references.ts`; see [private images and managed references](./IMAGES.md). Owner-protected raw-byte uploads verify JPEG/PNG/WebP/GIF with a pinned native decoder, enforce actual streaming size and bounded upload/decode work, and persist generated private files plus immutable metadata. Library/deletion and binary GET/HEAD routes never expose a directory mount or grant anonymous access. CommonMark parsing extracts canonical managed destinations from every configured Markdown field, alongside image-field references. Creation/saving, startup adoption, and explicit migrations validate files/images and update snapshot reference sets transactionally. Deletion checks draft and published references, reserves a non-referenceable tombstone before unlinking, and supports retry after partial filesystem/database failure. Published bytes/alt text remain independent of draft edits. Tests use real authentication, temporary files/SQLite, native decoders, cancellation, separate-connection races, and injected late failures. The Vite development file allow list excludes API storage. Publication-derived anonymous visibility remains step 7; no upload/editor UI or container verification is claimed. Verification: baseline `pnpm check` (67 tests) and `pnpm build` passed; final `pnpm check` passed (80 tests, including 10 new image-router tests and 3 shared reference tests), `pnpm build` passed, and `git diff --check` passed. A real Vite dev-server check returned 403 for an API-side `/@fs` request while web source remained available (200).

- Add authenticated, bounded image upload and image-library operations backed by the persistent filesystem directory and SQLite metadata.
- Accept only verified JPEG/PNG/WebP/GIF files up to 10 MiB. Use generated storage names, safe paths, and cleanup on failed/cancelled uploads; never trust original filenames or claimed MIME types.
- Keep all new uploads private. Do not expose the upload directory through a static-file mount.
- Define stable managed-image references and extract them from image fields and parsed Markdown image destinations, not regular-expression guesses.
- Validate referenced images when saving/publishing and track saved draft references for deletion protection. Cover Markdown in custom fields too.
- Keep image/alt-text use in published snapshots insulated from draft-only changes; do not replace published image bytes in place.
- Serve images through access-checked handlers, including HEAD/conditional request paths. Use cache behavior that cannot bypass current visibility checks.
- Block deletion while any saved draft or published version references an image. Handle filesystem/database partial failures without creating a public bypass or broken committed reference.

**Done when:** anonymous callers cannot fetch new uploads; forged, oversized, or unsupported files fail safely; image references are validated; referenced-image deletion is rejected. Use real temporary files and SQLite in tests.

## 7. Implement publication transitions and image visibility

Implemented in `apps/api/src/entries.ts`, `entry-http.ts`, `images.ts`, and `image-http.ts`; see [publication transitions and image visibility](./PUBLISHING.md). Owner-only publish/unpublish commands validate the saved revision and commit publication snapshots, timestamps/history, and image references in one transaction. First-publication history and slug locking survive unpublishing/restart. Saving still changes only the draft; admin states remain derived from actual snapshots. Binary image reads authorize against current published references transactionally, retaining owner-guarded private access; shared images stay public until their last current publication drops the reference. GET/HEAD/conditional reads always recheck visibility and use no-store responses. Late failure, stale-write, required-field, missing-file, separate-connection deletion/transition, and incompatible-configuration tests exercise real routers/files/SQLite. The race tests exposed synchronous SQLite busy waits starving filesystem checks; content transactions now use bounded cooperative retries only after SQL lock failures roll back. Public entry DTOs/routes/CORS and admin UI remain later work. Verification: baseline `pnpm check` (80 tests) and `pnpm build` passed; final `pnpm check` passed (89 tests, including 9 new publication-router tests), `pnpm build` passed, and `git diff --check` passed. The initially failing separate-connection race tests now pass without increasing their timeouts.

- Add explicit publish and unpublish operations using database transactions.
- Publishing validates the saved draft and atomically replaces the current published snapshot and its image references.
- Keep the first-published timestamp stable and lock the slug after first publication, including after unpublishing.
- Unpublish removes public availability without deleting the working draft.
- Derive public image access from references in current published snapshots. Shared images stay public while any published entry uses them.
- Republish/unpublish must update entry and image visibility together; reject races with deletion or incompatible entry changes.
- Derive the admin's unpublished/published/published-with-draft-changes states from actual draft/publication content rather than contradictory stored status flags.

**Done when:** tests exercise draft → publish → edit → save → republish → unpublish, shared images, removed image references, slug locking, and concurrent transition/deletion attempts. Visitors never see a half-published state.

## 8. Expose the public content API

Implemented in `apps/api/src/public-content.ts`, `public-content-http.ts`, and `packages/contracts/src/public-content.ts`; see [public content API usage, CORS, and caching](./PUBLIC_CONTENT_API.md). Anonymous schema-defined list/detail routes read only published snapshots, explicitly project fields and image URLs/alt text, retain Markdown source, and paginate with stable date/ID ordering. Public-only CORS accepts a wildcard or exact-origin allow list without credentials or changes to owner admission. Request-owned response hooks apply `no-store` and CORS even to malformed requests; HEAD/conditional reads recheck current availability. Real-router tests cover publication changes/restart, draft isolation, image visibility, Posts/Projects/custom types, dates/ties/pagination, opaque corrupt-storage failures, and CORS/error/preflight separation. Reverse-proxy/container verification and admin UI remain later work; independently cached consumer content cannot be recalled. Verification: baseline `pnpm check` (89 tests) and `pnpm build` passed; final `pnpm check` passed (97 tests, including 8 new public-router tests), `pnpm build` passed, and `git diff --check` passed.

- Add schema-defined REST/JSON routes for paginated lists by content type and lookup by content type plus slug.
- Project only published snapshots into public DTOs; never serialize database rows or drafts directly.
- Return Markdown source and public image URLs/alt text. Keep rendering on consuming sites.
- Sort Posts by supplied publication date or first-published timestamp; sort other types by first-published timestamp. Use a stable tie-breaker and bounded, schema-validated pagination.
- Configure public-read CORS separately from authenticated admin traffic so separate portfolio origins can read published data without opening credentialed management access.
- Ensure response/static/proxy caching cannot serve private CMS content after a visibility change. Document that independently cached portfolio pages and downloaded images cannot be recalled.
- Keep unknown/unpublished entries unavailable anonymously. Do not add GraphQL, arbitrary custom-field queries, or rebuild hooks.

**Done when:** anonymous real-router tests prove correct ordering/pagination, draft isolation, publication changes, custom-type delivery, and consistent image visibility.

## 9. Build the admin shell and entry lists

Implemented in `apps/web/src/App.svelte`, `lib/Workspace.svelte`, `lib/EntryList.svelte`, and `lib/admin.ts`; see [admin usage and verification](./ADMIN_WORKSPACE.md). The owner selected and confirmed the dark-only Gallery Index direction before implementation; its reusable rules are captured in `apps/web/DESIGN.md`. The scaffold product interactions are replaced by login/logout, protected configured-type navigation, title search, publication filters and 20-entry pagination. Shared-contract HttpApi clients decode safe definitions/pages; complete parameter keys, Query-owned cancellation, awaited auth invalidation, and private-cache removal prevent reuse after confirmed session loss/logout. Component tests exercise real clients through a controlled transport, including late-response cancellation. Full-page Chromium checks at 1440px/390px cover long titles, focus, navigation and empty/error/expired states using synthetic HTTP fixtures; production cookies/CSRF remain unverified in-browser. The inline finish review's login-alignment finding was corrected and recaptured; the mechanical design detector returned no findings. There are no dead editor/New entry actions: this is the browse-only step-9 slice. No unsaved authored editor input exists yet; step 10 must keep it outside the workspace's session-loss unmount boundary. Verification: pre-edit build passed and pre-edit check was blocked only by earlier design-file formatting; final `pnpm check` passed (103 tests), `pnpm build` passed, and `git diff --check` passed. No production-readiness claim is made.

- Confirm a small admin visual direction before UI implementation; the functional spec does not select a visual design. Use the established Svelte/Bits UI/Tailwind stack.
- Replace the demo screen as CMS screens become available; retain the real health endpoint and useful Query/Effect tests rather than preserving demo interactions as product features.
- Add login/logout, protected navigation, dynamic content-type navigation, and paginated entry lists with title search and publication-state filters.
- Use the existing QueryClient and abort-aware `runEffect` integration. Include every request parameter in query keys, avoid automatic mutation retries, and await appropriate invalidation after writes.
- Clear protected cached data on logout/session loss and handle expired sessions without losing unsaved editor state silently.
- Cover loading, empty, failure, keyboard/focus, narrow viewport, and long-title states.

**Done when:** the owner can sign in and browse/manage entry lists without the scaffold demo, and component/browser tests verify navigation, search, filtering, and session/cache behavior.

## 10. Build generated editing forms and the image library

Implemented in `apps/web/src/lib/EntryEditor.svelte`, `FieldEditor.svelte`, `MarkdownPreview.svelte`, `ImageLibrary.svelte`, `editor-model.ts`, and `editing.ts`; see [editing and image-library usage](./CONTENT_EDITING.md). The existing Gallery Index design is extended with definition-generated controls for every field kind, schema-derived field errors, creation-only defaults, lossless text-list items, explicit revision-checked commands, locked historical slugs, saved/publication comparisons, and native permanent-delete confirmations. Parsed CommonMark previews never inject HTML or execute MDX/unsafe URLs; managed-image selection/insertion carries per-use alt text and authenticated previews. Library uploads/deletion/pagination use shared schema-decoding contracts with CSRF headers, no mutation retries and awaited invalidation. The editor remains mounted outside the session-loss boundary, retaining input without browser storage; stale-write comparison never rebases or merges automatically. Component tests cover commands, errors, conflicts, confirmation, image selection, safe preview and session/input/cache behavior. A real Chromium owner workflow against production routers/migrations with temporary on-disk SQLite/files exercised a Post, a Project, the opt-in Talks type, all nine field kinds, upload/preview, publication/image visibility, guarded entry/image deletion, a separate-writer conflict and logout/401/re-authentication. Desktop 1440px and narrow 390px full-page captures were inspected. The finish review was inline; new typography advisories were resolved against the incumbent ramp, leaving pre-existing documentation drift unchanged. Verification: baseline `pnpm check` (103 tests) and `pnpm build` passed; final `pnpm check` passed (115 tests), `pnpm build` passed, and `git diff --check` passed. Browser checks used loopback HTTP, not production HTTPS/Secure cookies, reverse-proxy/container/static serving or deployment readiness; those remain steps 11–12.

- Render the agreed field kinds from validated content definitions; reuse Effect Schemas for field errors while keeping server validation authoritative.
- Add explicit Save draft, Publish, Unpublish, and Delete actions, pending/error feedback, and permanent-delete confirmations.
- Add a safe Markdown preview: no executable MDX, unsafe raw HTML, or unsafe URL execution. Support managed-image insertion and authenticated private-image previews.
- Add image upload/selection, alt text, image-library listing, and deletion with actionable reference-conflict errors.
- Show saved draft/publication differences clearly and enforce read-only slugs after first publication.
- Warn on unsaved navigation, retain user input on validation/network errors, and offer a truthful stale-write conflict flow. Do not add autosave or automatic merges.
- Keep confirmation dialogs, form labels/errors, focus movement, and editor controls accessible and usable on narrow screens.

**Done when:** a real owner workflow covers a Post, a Project, and a configured custom type, including every field kind, private uploads, preview, saving, publishing, unpublishing, and guarded deletion.

## 11. Package the single-service deployment

Implemented in `apps/api/src/admin-http.ts`, the API build configuration and inline asset-copy command, and the multi-stage `Dockerfile`; see [deployment and maintenance](./DEPLOYMENT.md). Production serves a startup snapshot of the compiled admin on the API origin, with GET/HEAD/deep-link handling, correct MIME types, no-store/nosniff, no request-derived filesystem reads, and fail-closed missing-build/symlink checks. Unknown API/storage/missing-asset paths remain errors, and existing API errors are preserved. The package includes all server/owner/migration entries and generated chunks, bundled shared contracts/schemas, production Yielded dependencies and native image decoding. The container runs as UID 1000, listens internally on all interfaces, persists only `/data`, and retains scoped signal shutdown. `tools/verify-deployment.py` builds from a source-only checkout, exercises hidden create/recover prompts and production cookie flags, publishes an entry/image, replaces/rebuilds the service, archives the entire stopped volume, restores into a fresh volume, checks SQLite integrity and verifies restored authority/content/image visibility. Documentation covers HTTPS proxy/origins, configuration edits, explicit conversions, upgrade/rollback and the tested whole-volume/configuration backup procedure. The configured migration registry is empty, so the packaged migration command is verified through its unconfigured-version failure; conversion semantics remain covered by the existing real SQLite tests. Verification: baseline build passed; baseline check had an existing intermittent authentication failure in `entry-http.test.ts` (114/115 passed). Final `pnpm check` passed (118 tests, including 3 new static-router tests), `pnpm build` passed, Docker build and restart/rebuild/fresh-volume restore smoke passed, and `git diff --check` passed. Container HTTP checks do not claim real HTTPS browser/Secure-cookie/reverse-proxy verification or completion of step 12.

- Extend the Effect server to serve the built admin and API on one origin. Static routing must not expose the database/uploads, swallow API errors, or turn unknown API requests into SPA HTML.
- Update the production build to include the CLI and required runtime dependencies/assets, not only the current API entry. Verify shared code and Yielded Auth are bundled or shipped correctly.
- Add a multi-stage Dockerfile, ignore rules, and a minimal local build/run example. This builds from the owner's configured checkout; it is not a prebuilt-image distribution platform.
- Run as a non-root user, bind the container listener appropriately, persist database/images outside the image, and shut down scoped resources cleanly.
- Document HTTPS reverse-proxy setup, trusted origin settings, first-owner setup, recovery, configuration edits, migrations, and upgrade steps.
- Document and test a maintenance-window backup/restore procedure covering SQLite, images, and the matching configuration. Do not recommend copying a live SQLite file without accounting for its journal/WAL state.

**Done when:** a clean source checkout can build and start one container, create the owner, retain content across restart/rebuild, and restore into a fresh volume. Admin deep links work while unknown API paths remain API errors.

## 12. Verify v1 and finish operator documentation

Implemented in `apps/web/e2e/cms.spec.ts`, its strict/typechecked Playwright configuration, `tools/https-proxy.mjs`, and the opt-in `pnpm verify:v1` orchestration in `tools/verify-deployment.py`. The source-only fixture adds Talks only in a disposable checkout, builds the production Dockerfile, and serves the compiled admin through a real test-certificate HTTPS proxy container. Chromium verifies browser-issued Secure/HttpOnly/host-only/Strict cookies, Origin/CSRF admission, keyboard/focus, navigation, all nine field kinds, private image selection/Markdown preview, Post/Project/custom-type publication, draft isolation, invalid/XSS inputs, forged uploads, duplicate/locked slugs, concurrent-writer conflicts, deletion guards, offline failure and retained input across logout/401/re-authentication. Full-page desktop 1440px/narrow 390px captures were inspected, with overflow assertions at capture points. The same acceptance command verifies compiled hidden-prompt owner operations, restart/rebuild, whole-stopped-volume backup and fresh-volume restore from matching backed-up source, SQLite integrity, recovery invalidation, incompatible configuration rejection, an actual packaged Summary-to-Abstract migration, replay rejection and preserved content/image access. The operator's checkout/configuration and migration registry are never modified by fixtures. README now explains the actual CMS workflow, configuration, public consumption, deployment and verification, linking the spec/glossary/roadmap and detailed operator guides. See [verification evidence and limitations](./VERIFICATION.md) for the behavior-to-test matrix and reproducible commands. Baseline `pnpm check` (118 tests) and `pnpm build` passed. Checks/build and HTTPS browser/container/operator workflows passed, but a later full check (117/118 passed) and an isolated entry-router run reproduced the pre-existing intermittent authenticated 401. Later file/suite loops and a 4,000-read probe passed without identifying the cause; temporary instrumentation/probes were removed, and no policy/assertion/timeout was weakened. This remains a release-acceptance blocker, not a fixed flake or an unconditional step-12 acceptance claim. Untested engines/architectures/physical devices, certificate provisioning and the operator's actual proxy/firewall also remain explicit acceptance limits.

- Run `pnpm check` and `pnpm build`; fix regressions without weakening checks or overwriting unrelated work.
- Run browser smoke tests against the production-shaped service/container. Add only the browser-test infrastructure needed to verify real cookie, CSRF, navigation, and editor behavior beyond jsdom.
- Verify the complete owner workflow and anonymous delivery using real SQLite, files, HTTP routes, and production migrations.
- Include negative cases: anonymous writes/private-image requests, invalid field values, XSS preview input, bad uploads, duplicate/locked slugs, stale saves, conflicting deletion, and incompatible schema changes.
- Verify restart, explicit data migration, backup/restore, password recovery, and operator-visible failure messages without exposing secrets.
- Visually inspect the shipped admin at desktop and narrow sizes; check keyboard operation, focus, errors, empty states, and overflow.
- Update `README.md` from scaffold instructions to the actual CMS workflow and link configuration examples, API usage, operator procedures, the spec, glossary, and roadmap.
- Report remaining blockers honestly. Do not claim production readiness from type checks or component tests alone.

**Done when:** every approved v1 behavior has implementation and relevant verification evidence, the documented self-hosting workflow works from a clean checkout, and all remaining limitations are explicit.

## Scope guard

Do not add multi-user/tenant accounts, visual schema editing, relationships/nested groups, rich-text/MDX, autosave, revision history, scheduled publication, manual ordering, multilingual infrastructure, redirects, GraphQL, webhooks, analytics, image transforms, cloud storage, backup automation, or package/image distribution infrastructure during these steps. Future admin-based schema editing remains recorded in the roadmap.
