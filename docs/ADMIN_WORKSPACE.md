# Admin shell and entry lists

Step 10 adds [generated editing forms and image management](./CONTENT_EDITING.md) to this workspace. The verification below records the original step-9 slice; current editor/browser evidence is documented separately.

Step 9 replaces the scaffold screen with the approved **Gallery Index** admin: dark-only aubergine/plum surfaces, title-led rows, explicit publication states, and responsive navigation. See [the design system](../apps/web/DESIGN.md) and [product context](../apps/web/PRODUCT.md).

## Use locally

1. Create the owner with `pnpm --filter @zupka/api owner:create` if this deployment does not already have one.
2. Run `pnpm dev` and open the exact configured admin origin (by default `http://127.0.0.1:5173`).
3. Sign in. Content-type navigation comes from the authenticated, schema-decoded `/api/admin/content-types` description; it is not a hard-coded Posts/Projects menu or a browser import of server configuration.
4. Choose a type, enter a title search and press **Search** or Enter. Changing publication state applies that filter immediately to the currently submitted search. Search and state changes return to the first page.
5. Use Previous/Next to browse 20 entries at a time. The management API sorts by last save, then entry ID; this is distinct from the public API's publication-date ordering. Displayed updated dates are UTC.

Publication states are **Unpublished**, **Published**, and **Published with draft changes**. They reflect the API's actual draft/published snapshots, not editable client status flags. Clear filters restores the unfiltered first page. An emptied later page offers a return to the first page.

Content-type links use `#/content/:typeId`, so they survive reload and browser navigation without requiring path-based editor routes. Unknown type links show an explicit not-found state. Search/filter/page choices are local to the selected list and reset when switching types; they are not durable bookmarks. The skip link and navigation focus movement support keyboard use. Long titles wrap in full; narrow screens stack metadata rather than crop it.

## Request and session ownership

- `Root.svelte` continues to own one QueryClient and clears it on destruction. `admin.ts` uses the shared `EntriesApi` HttpApiClient, decoding both configuration descriptions and entry-page responses. All private queries share the `admin` key prefix.
- List keys include type ID, submitted title search, publication state (including All), limit and offset. Query AbortSignals pass through `readAdmin` and the existing `runEffect` bridge into the HTTP transport. A fresh parameter-identical page can reuse the cache.
- Session reads use `owner-session`, revalidate on focus/reconnect and every 60 seconds in foreground tabs, with no automatic retries. Background throttling and disconnected clients prevent any hard expiry-display deadline; the server still authorizes every private read.
- A null session or management 401 removes the protected workspace, cancels private requests and removes all `admin` queries. Step 10 keeps an open editor mounted but hidden outside that workspace boundary so local input survives re-authentication. Cancellation prevents late responses from restoring protected data. Session expiry has an explicit sign-in-again message.
- Successful sign-in clears old private data and **awaits** session invalidation/refetch. Sign-out has no automatic retries; after confirmed success it cancels session/private reads, clears authority and private cached data, and returns to an empty-password login form. Failed sign-out stays actionable rather than claiming success.
- Credentials never become mutation variables or browser storage. The form clears its password on success/failure; auth mutations have zero cache retention after they become unused. Step-10 content mutations use the shared contracts with explicit CSRF admission, no automatic retries and awaited invalidation.
- Session-check outages hide the workspace until verification recovers. List outages preserve search/filter controls and offer retry; errors never print raw backend/transport details.

## Scope boundary

Step 9 was the browse-only entry-list slice. Step 10 now makes titles and **New entry** open generated editors and adds **Images** navigation. Creation/editing, explicit publication transitions, guarded deletion, previews, image management and unsaved-navigation warnings are described in [content editing](./CONTENT_EDITING.md).

The original list tests do not establish editor guarantees. Dedicated editor tests and the step-10 real-owner browser workflow verify retained in-memory input across session loss and re-authentication; no editor recovery survives a closed/reloaded tab.

The health endpoint and useful transport/Query/Effect tests remain. Demo health toggles and the example dialog are no longer product UI; the existing isolated Bits UI dialog tests remain scaffold verification.

## Verification

Automated component tests use the production Query provider seam and real schema-decoding HTTP clients with a controlled fetch transport, not module mocks. Coverage includes sign-in/rejection/logout, dynamic custom-type navigation, focus, all list parameters/cache identity, page reset, full long titles, safe text rendering, loading/empty/failure states, malformed definitions, 401 expiry, cache removal and cancellation of late private responses. The real-router tests for authentication and entries continue to exercise SQLite and server security separately.

`pnpm check` passes (103 tests); `pnpm build` and `git diff --check` pass. The pre-edit check was blocked only by formatting of the earlier design decision files; the pre-edit build passed. Those design files were formatted without changing their approved direction.

Chromium 156 was driven through CDP against the running Vite app at desktop 1440px and narrow 390px widths, using **synthetic HTTP fixtures**. Full-page captures were opened and inspected for long titles, publication states, empty/error/expired states, visible keyboard focus and overflow; both widths had no horizontal overflow. Navigation focused the content heading, and a 401 removed the private workspace. The login alignment found in the first pass was corrected and recaptured. The one mechanical design-detector run returned no findings. The finish review was performed inline, not by an independent subagent; its verdict marked the recorded alignment fix resolved.

Local captures and the CDP report live under `apps/web/.impeccable/review/` and are ignored to avoid committing future private-content screenshots. This browser pass does **not** verify real cookies/CSRF, production static serving, a reverse proxy, or a container. The subsequent [v1 acceptance workflow](./VERIFICATION.md) verifies those boundaries
against the compiled admin, a real HTTPS proxy and a disposable container; the
step-9 fixture evidence above stays scoped to its original test.
