# CMS v1 implementation plan

Status: planned; implementation has not started.

The approved [specification](./SPEC.md) defines scope. [GLOSSARY.md](../GLOSSARY.md) defines terminology; [ROADMAP.md](./ROADMAP.md) contains future work, not v1 requirements. Complete the steps in order and add verification alongside each slice rather than postponing tests until the end.

## Starting point

The inspected scaffold already provides:

- An Effect 4.0.6 HTTP backend with a health endpoint and real-router tests.
- Shared Effect Schema/HttpApi contracts in `packages/contracts`.
- A Svelte 5 SPA with Bits UI, Tailwind, TanStack Query, and an abort-aware Effect-to-Promise bridge.
- Vite+ build, test, lint, formatting, and type-check commands.
- An intentionally empty `packages/shared` package.

It does not yet provide persistence, authentication, CMS features, or production static-file serving. Preserve existing working-tree changes; do not reset or replace them as part of implementation.

## Implementation shape

Use the existing workspace; do not introduce a plugin system or another application framework.

- `packages/shared`: concrete, browser-safe content definitions, domain schemas, field-schema construction, and pure domain rules. Add its Effect dependency when it gains real code.
- `packages/contracts`: explicit admin/public DTOs, typed errors, and HTTP contracts composed from shared schemas.
- `apps/api`: the typed content configuration, cohesive content/auth/image modules, SQLite/filesystem adapters, CLI entry, and runtime composition.
- `apps/web`: admin screens, generated field editors, and schema-decoding clients using the existing Query/Effect integration.

These are responsibility assignments, not a requirement to create every file or abstraction up front. Keep runtime configuration, credentials, filesystem paths, and persistence implementations out of browser imports. The admin receives a schema-validated, safe description of configured content types rather than importing server configuration.

## 1. Establish the baseline and verify dependency compatibility

- Run `pnpm check` and `pnpm build`; record pre-existing failures before editing code.
- Verify and pin a released Yielded Auth version compatible with the installed Effect and Node versions. The beta version noted in the spec is an inspection result, not an instruction to install it blindly.
- Verify the Effect SQL SQLite driver and Yielded Auth persistence adapter can share the intended SQLite setup on Node 26.
- Establish a small executable integration test for password sign-in, a stateful session, and the direct Effect HTTP client without React.
- Confirm supported owner provisioning and operator-driven password recovery mechanisms. Do not assume public registration or emailed reset flows are suitable for the CLI.

**Done when:** the scaffold baseline is understood, the chosen dependency versions build, and the auth/persistence integration is demonstrated. Resolve or report a blocker here before building the CMS on an unverified auth integration; do not silently substitute another auth library.

## 2. Define the content model and code configuration

- Define Effect Schemas for entry/type/image identifiers, slugs, field definitions, values, draft/publication data, and expected domain errors.
- Implement the agreed field palette: text, number, boolean, date/time, URL, Markdown, image, fixed-choice select, and text lists.
- Provide typed Posts and Projects definitions and a small example of a custom content type and custom fields.
- Require title and slug for every type; reject duplicate type/field identifiers, reserved-field collisions, and invalid defaults or select definitions.
- Build draft and publish schemas from the same definitions. Drafts may omit required custom fields but must validate supplied values; published entries must satisfy all requirements.
- Apply defaults only on entry creation. Keep date normalization and slug suggestions deterministic.
- Expose a safe, serializable content-type description and rebuild the same field schemas in the admin from that description.

**Done when:** schema tests cover every field kind, malformed configuration, incomplete drafts, publish validation, and defaults without unchecked casts or duplicate hand-written validators.

## 3. Add SQLite persistence and schema compatibility checks

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

- Compose Yielded Auth password authentication and durable stateful sessions with the database layer.
- Mount only the required sign-in/session/logout operations; do not expose public signup, setup, or email recovery endpoints.
- Provide local CLI commands for owner creation and password recovery, with hidden interactive password prompts and a single-owner invariant.
- Ensure password recovery invalidates existing authority/sessions using the verified Yielded Auth integration.
- Use secure production cookie settings, explicit trusted origins, CSRF protections, bounded password work, and sign-in rate limiting. Keep secrets and passwords out of logs and errors.
- Make authentication/owner authorization mandatory for all subsequent management routes, including upload and private-image access.

**Done when:** real HTTP tests demonstrate sign-in, rejection, logout, session invalidation after recovery, and anonymous denial. Provisioning a second owner is rejected, and no public account-creation route exists.

## 5. Deliver the draft-management slice

- Implement authenticated entry creation, retrieval, listing, saving, and deletion through a cohesive entry module and thin HTTP handlers.
- Support per-type title search, pagination, and the publication-state filters required by the admin.
- Suggest editable initial slugs; enforce title/slug requirements and uniqueness through both domain parsing and database constraints.
- Preserve the distinction between a working draft and a published version. Saving never mutates the published snapshot.
- Guard concurrent writes so an old editor tab or an overlapping transition cannot silently overwrite newer state. Surface a conflict rather than auto-merging.
- Reject deletion of published entries; leave destructive UI confirmation to the admin step.

**Done when:** an authenticated caller can manage text-only drafts, invalid values and duplicate slugs are rejected, stale saves conflict, and another public version cannot be changed by saving a draft.

## 6. Implement private uploads and managed-image references

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

- Add explicit publish and unpublish operations using database transactions.
- Publishing validates the saved draft and atomically replaces the current published snapshot and its image references.
- Keep the first-published timestamp stable and lock the slug after first publication, including after unpublishing.
- Unpublish removes public availability without deleting the working draft.
- Derive public image access from references in current published snapshots. Shared images stay public while any published entry uses them.
- Republish/unpublish must update entry and image visibility together; reject races with deletion or incompatible entry changes.
- Derive the admin's unpublished/published/published-with-draft-changes states from actual draft/publication content rather than contradictory stored status flags.

**Done when:** tests exercise draft → publish → edit → save → republish → unpublish, shared images, removed image references, slug locking, and concurrent transition/deletion attempts. Visitors never see a half-published state.

## 8. Expose the public content API

- Add schema-defined REST/JSON routes for paginated lists by content type and lookup by content type plus slug.
- Project only published snapshots into public DTOs; never serialize database rows or drafts directly.
- Return Markdown source and public image URLs/alt text. Keep rendering on consuming sites.
- Sort Posts by supplied publication date or first-published timestamp; sort other types by first-published timestamp. Use a stable tie-breaker and bounded, schema-validated pagination.
- Configure public-read CORS separately from authenticated admin traffic so separate portfolio origins can read published data without opening credentialed management access.
- Ensure response/static/proxy caching cannot serve private CMS content after a visibility change. Document that independently cached portfolio pages and downloaded images cannot be recalled.
- Keep unknown/unpublished entries unavailable anonymously. Do not add GraphQL, arbitrary custom-field queries, or rebuild hooks.

**Done when:** anonymous real-router tests prove correct ordering/pagination, draft isolation, publication changes, custom-type delivery, and consistent image visibility.

## 9. Build the admin shell and entry lists

- Confirm a small admin visual direction before UI implementation; the functional spec does not select a visual design. Use the established Svelte/Bits UI/Tailwind stack.
- Replace the demo screen as CMS screens become available; retain the real health endpoint and useful Query/Effect tests rather than preserving demo interactions as product features.
- Add login/logout, protected navigation, dynamic content-type navigation, and paginated entry lists with title search and publication-state filters.
- Use the existing QueryClient and abort-aware `runEffect` integration. Include every request parameter in query keys, avoid automatic mutation retries, and await appropriate invalidation after writes.
- Clear protected cached data on logout/session loss and handle expired sessions without losing unsaved editor state silently.
- Cover loading, empty, failure, keyboard/focus, narrow viewport, and long-title states.

**Done when:** the owner can sign in and browse/manage entry lists without the scaffold demo, and component/browser tests verify navigation, search, filtering, and session/cache behavior.

## 10. Build generated editing forms and the image library

- Render the agreed field kinds from validated content definitions; reuse Effect Schemas for field errors while keeping server validation authoritative.
- Add explicit Save draft, Publish, Unpublish, and Delete actions, pending/error feedback, and permanent-delete confirmations.
- Add a safe Markdown preview: no executable MDX, unsafe raw HTML, or unsafe URL execution. Support managed-image insertion and authenticated private-image previews.
- Add image upload/selection, alt text, image-library listing, and deletion with actionable reference-conflict errors.
- Show saved draft/publication differences clearly and enforce read-only slugs after first publication.
- Warn on unsaved navigation, retain user input on validation/network errors, and offer a truthful stale-write conflict flow. Do not add autosave or automatic merges.
- Keep confirmation dialogs, form labels/errors, focus movement, and editor controls accessible and usable on narrow screens.

**Done when:** a real owner workflow covers a Post, a Project, and a configured custom type, including every field kind, private uploads, preview, saving, publishing, unpublishing, and guarded deletion.

## 11. Package the single-service deployment

- Extend the Effect server to serve the built admin and API on one origin. Static routing must not expose the database/uploads, swallow API errors, or turn unknown API requests into SPA HTML.
- Update the production build to include the CLI and required runtime dependencies/assets, not only the current API entry. Verify shared code and Yielded Auth are bundled or shipped correctly.
- Add a multi-stage Dockerfile, ignore rules, and a minimal local build/run example. This builds from the owner's configured checkout; it is not a prebuilt-image distribution platform.
- Run as a non-root user, bind the container listener appropriately, persist database/images outside the image, and shut down scoped resources cleanly.
- Document HTTPS reverse-proxy setup, trusted origin settings, first-owner setup, recovery, configuration edits, migrations, and upgrade steps.
- Document and test a maintenance-window backup/restore procedure covering SQLite, images, and the matching configuration. Do not recommend copying a live SQLite file without accounting for its journal/WAL state.

**Done when:** a clean source checkout can build and start one container, create the owner, retain content across restart/rebuild, and restore into a fresh volume. Admin deep links work while unknown API paths remain API errors.

## 12. Verify v1 and finish operator documentation

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
