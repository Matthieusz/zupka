# Zupka

Minimal pnpm workspace: Svelte 5 + Bits UI + Tailwind CSS, backed by Effect 4.
Vite+ owns dev tooling, builds, Vitest, Oxlint, and Oxfmt.

## Start

Use Node.js 26.x.

```sh
pnpm install
pnpm dev
```

Open http://127.0.0.1:5173. The API listens on http://127.0.0.1:3001.
Vite proxies `/api` to the backend. The page fetches the health endpoint through
the shared, schema-decoding HttpApi client and includes an accessible Bits UI dialog.

## Layout

```text
apps/
  web/          Svelte SPA, Tailwind, Bits UI
  api/          Effect HTTP implementation and Node runtime
packages/
  contracts/    Effect Schema + HttpApi; shared server/client contract
  shared/       Reserved for shared domain utilities; intentionally empty
tools/
  oxlint/
    anti-slop/  Vendored Dillon Mulroy anti-slop rules, licenses, provenance
```

Workspace packages expose TypeScript source directly. Vite bundles it for the
browser, and Vite+ pack bundles the API's contract into its production entry.
No separate package build step is needed.

## Commands

| Command                            | Purpose                                                 |
| ---------------------------------- | ------------------------------------------------------- |
| `pnpm dev`                         | Start both apps using the Vite+ task runner             |
| `pnpm check`                       | Formatting, type-aware lint, type checks, and all tests |
| `pnpm lint`                        | Oxlint with anti-slop and Effect-specific rules         |
| `pnpm format`                      | Oxfmt, including Svelte files                           |
| `pnpm format:check`                | Check formatting without changes                        |
| `pnpm typecheck`                   | Effect-patched tsrs plus Svelte-specific checks         |
| `pnpm test`                        | Vitest API and component tests                          |
| `pnpm build`                       | Build both apps                                         |
| `pnpm --filter @zupka/api start`   | Run the built API                                       |
| `pnpm --filter @zupka/web preview` | Preview the built frontend                              |

Root `vite.config.ts` owns lint, formatting, and test projects. Each app has its
own Vite+ build configuration. API tests exercise the actual HTTP router;
frontend tests cover the real Bits UI dialog and the Query/Effect integration.

## Server state: TanStack Query + Effect

`apps/web/src/Root.svelte` creates one QueryClient and provides it to the app.
Queries stay fresh for 30 seconds, retry once, refetch stale data on mount and
reconnection, and do not refetch on window focus. Mutations do not retry.
The root clears the cache on destruction.

`apps/web/src/lib/effect.ts` bridges Effect programs to Promises using the
existing default Effect runtime; it does not create a ManagedRuntime per request.
It forwards Query's AbortSignal to `Effect.runPromise`, rejects already-aborted
requests before execution, and unwraps expected failures so Query receives the
original typed error rather than a FiberFailure wrapper. Defects and interruption
remain runtime failures. Promise types cannot encode rejection types, so the
query/mutation error type is derived from `Effect.Error<ReturnType<typeof loadHealth>>`.

`App.svelte` uses Svelte 5 accessor options (`createQuery(() => ({ ... }))`),
not stores or `$effect` fetching. Query owns data, loading, errors, retries and
invalidation; a local rune owns whether the query is enabled. Disabling it also
cancels the active request. The health endpoint has no parameters, so its key
is deliberately stable: `["health"]`. When adding parameterized endpoints,
include every request parameter in the key inside the reactive options callback.

The manual-check `createMutation` calls the existing **read-only** health endpoint
and awaits health-query invalidation on success. This demonstrates imperative
execution and invalidation, not a server write. Ordinary refresh buttons should
normally use `query.refetch()`; replace the demo operation with a real write when
one exists. TanStack mutations do not supply an automatic AbortSignal, unlike
queries. The helper accepts an optional caller-owned signal if needed.

Tests cover cancellation down to the HTTP transport, pre-aborted signals, typed
failures, reactive enabled options, cache-key reuse, empty/error/loading states,
and refetching after mutation success.

References: [Svelte Query quick start](https://tanstack.com/query/latest/docs/framework/svelte/quick-start),
[query cancellation](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation).

## TypeScript and Svelte checks

The workspace uses [`tsrs`](https://github.com/oxc-project/tsrs)
**0.20.0-ts7.1.0-beta** through [`@effect/tsgo`](https://github.com/Effect-TS/tsgo)
**0.59.0**. `pnpm typecheck` runs `effect-tsgo tsrs`, which supplies the
Effect-patched compiler without rewriting `node_modules`. The shared tsconfig
enables Effect diagnostics alongside TypeScript's strict checks, explicitly
allowing the existing unstable HTTP and Node platform modules. Both root and web
TypeScript projects use this compiler; Svelte components are checked separately.

For editor LSP integration, launch `pnpm exec effect-tsgo tsrs --lsp --stdio`
for TypeScript files instead of a second TypeScript language server. Keep the
Svelte language server for components. Effect's bundled tsrs currently does not
support Linux musl.

The web app retains a local TypeScript **6.0.3** dependency because
`svelte-check@4.7.7` supports TypeScript 5/6 and requires the legacy compiler API.
`svelte-check` checks component types and Svelte accessibility/compiler diagnostics.
Oxlint does not lint Svelte templates; these checks complement it.

## API and configuration

`GET /api/health` returns `{"status":"ok"}`. Add endpoints and response schemas
in `packages/contracts/src/index.ts`, then implement their handlers in
`apps/api/src/app.ts`. The frontend uses the same contract via `HttpApiClient`.

The backend reads `HOST` (default `127.0.0.1`) and `PORT` (default `3001`)
using Effect Config. If you change the API port during development, update
the proxy target in `apps/web/vite.config.ts`.

Production frontend files are in `apps/web/dist`; the API entry is
`apps/api/dist/main.mjs`. The API requires its production dependencies.
Deploy static files with a same-origin reverse proxy forwarding `/api` to
the API. The API does not serve the frontend, and Vite's dev proxy is not
a production deployment server.

No database, authentication, or deployment infrastructure is included.
