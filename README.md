# Zupka

A self-hosted, single-owner headless CMS for independently built portfolio sites.
Configure content types in TypeScript, author in the private Svelte admin, and
explicitly publish through a read-only JSON API. Portfolio presentation, Markdown
rendering and consumer-site rebuilds stay outside the CMS.

## What v1 includes

- Posts and Projects, plus code-defined custom types and fields.
- Generated editors for text, number, boolean, date/time, URL, Markdown, image,
  fixed-choice select and text lists.
- Independent saved drafts and published versions; explicit Save draft, Publish,
  Unpublish and permanent Delete actions. No autosave or revision history.
- Safe Markdown preview and verified JPEG/PNG/WebP/GIF uploads up to 10 MiB.
  Images are private until referenced by a current publication; saved references
  protect them from deletion.
- One local owner, password authentication and revocable cookie sessions.
  Provisioning and recovery are terminal-only; there is no public signup/reset.
- One locally built, non-root container serving admin/API on the same origin,
  with SQLite and images on persistent disk behind your HTTPS reverse proxy.

See the approved [specification](docs/SPEC.md), [glossary](GLOSSARY.md),
[implementation/verification record](docs/IMPLEMENTATION_PLAN.md), and
[roadmap](docs/ROADMAP.md). Multi-user accounts, relationships, visual schema
editing, scheduling, image transformations and cloud storage are not v1 features.

## Deploy your configured checkout

1. Clone this repository and edit `apps/api/src/content-config.ts`.
2. Build locally with `docker build -t zupka:local .`.
3. Create a persistent volume and provision the owner with the compiled CLI.
4. Run one container with an explicit HTTPS `AUTH_ORIGIN`; forward the whole
   origin from your HTTPS proxy to the container.
5. Retain the volume and matching configured source across upgrades.

Follow the complete [deployment guide](docs/DEPLOYMENT.md) for exact build/run,
non-root permissions, proxy, owner creation/recovery, migrations, upgrades and
maintenance-window backup/restore commands. Do not expose the upload directory or
cache private API/image responses. Do not copy just a live SQLite file.

## Local development

Use Node 26.x and pnpm 12.14.0 (the `packageManager` field pins pnpm).

```sh
pnpm install --frozen-lockfile
pnpm --filter @zupka/api owner:create
pnpm dev
```

Open **http://127.0.0.1:5173**. Vite proxies `/api` to the Effect server at
`127.0.0.1:3001`. Use that exact origin, not `localhost`, unless you also set
`AUTH_ORIGIN`. Both processes must use the same storage as the operator commands.

### Verify owner login locally

`owner:create` prompts for your email, hidden password (12–1024 characters), and
confirmation. Sign in, reload, restart the API, and sign out. Sessions persist
across restart; logout revokes the current session. To recover a forgotten password:

```sh
pnpm --filter @zupka/api owner:recover
```

Use the existing email and a new hidden password. Recovery invalidates the old
password and all sessions. Never pass passwords through arguments/environment
variables or delete the database to recover access.

Source package commands default to `apps/api/zupka.sqlite` and
`apps/api/uploads`. For another location, set the **same absolute** `DATABASE_PATH`
and `UPLOADS_PATH` for the API and every CLI; create the database's parent directory
first. Keep storage and journal files private and outside public/static directories.
Production requires an explicit HTTPS `AUTH_ORIGIN`, with Secure, HttpOnly,
host-only, SameSite=Strict cookies. HTTP cookies are loopback-development only.
See [authentication/security](docs/AUTHENTICATION.md) for CSRF, expiry and limits.

## Author and publish

1. Choose Posts, Projects or another configured type, then **New entry**.
2. Enter a title; the editor suggests an editable slug. Include optional fields
   as needed, upload/select images, and preview Markdown.
3. **Save draft** validates and persists the working version. It does not change
   any existing public version. Resolve field errors before retrying.
4. **Publish** validates the saved version and makes it public. Slugs lock after
   first publication, even after unpublishing. Unsaved changes cannot be published.
5. **Unpublish** removes availability but retains the draft. Unpublish before
   deleting an entry; remove all saved references before deleting an image.

Stale saves conflict rather than overwrite. Load the latest saved version to
compare, then explicitly discard or keep local work; there is no automatic merge.
Session loss retains an open editor's input **in memory in that tab**, not durable
browser storage. Closing/reloading the tab is not an unsaved-content recovery path.

See [admin navigation/lists](docs/ADMIN_WORKSPACE.md),
[editing/images](docs/CONTENT_EDITING.md), [draft API](docs/DRAFT_MANAGEMENT.md),
[publication rules](docs/PUBLISHING.md) and [image operations](docs/IMAGES.md).

## Configure content

[Configuration examples](docs/CONTENT_CONFIGURATION.md) explain the typed Posts,
Projects and opt-in Talks definitions. Defaults apply only at creation. Optional
additions can be adopted at startup without rewriting saved content; incompatible
edits are rejected until an explicit operator-authored conversion runs.

Configuration edits require a rebuild/redeploy. Back up the old data/configuration
pair before changing it. See [storage and explicit migrations](docs/CONTENT_STORAGE.md)
and the [upgrade/rollback procedure](docs/DEPLOYMENT.md#recovery-configuration-changes-and-upgrades).
The default migration registry is intentionally empty.

## Consume published content

```sh
curl 'https://cms.example.com/api/content/posts?limit=20&offset=0'
curl 'https://cms.example.com/api/content/projects/my-project'
```

No API key is needed. Responses contain only published fields, Markdown source,
and root-relative image URLs with per-use alt text. Resolve image URLs against the
CMS origin; render Markdown safely in the consuming site. `PUBLIC_READ_ORIGINS`
configures credential-free public CORS separately from owner admission.

See [public API shapes, ordering, pagination, CORS and caching](docs/PUBLIC_CONTENT_API.md).
Unknown/unpublished entries are unavailable. Unpublishing cannot recall previously
downloaded images or content independently cached by a portfolio.
`GET /api/health` returns `{"status":"ok"}`.

## Verify a checkout

```sh
pnpm check
pnpm build
# One-time browser installation after installing workspace dependencies:
pnpm exec playwright install chromium
pnpm verify:v1
```

`pnpm check` covers formatting, type-aware lint, strict Effect/TypeScript and
Svelte checks, and real-router/SQLite/filesystem/schema/component tests. The
browser files are also typechecked. `pnpm build` builds the admin plus server and
operator CLIs, copying public assets into `apps/api/dist/public`.

`pnpm verify:v1` additionally requires Linux Docker, Python 3.12+, OpenSSL and
Playwright Chromium. It builds disposable configured containers and a local TLS
proxy, exercises the real browser owner workflow, then checks restart/rebuild,
backup/fresh-volume restore, password recovery, incompatible configuration and a
successful packaged migration. It never targets an existing CMS volume. Screenshots
are local ignored artifacts in `test-results/browser/`; no request traces are saved.
For the lighter HTTP-only packaging check, run `python3 tools/verify-deployment.py`.

See [v1 verification evidence and limitations](docs/VERIFICATION.md). An existing
intermittent authenticated-401 failure was reproduced in the entry-router suite;
its root cause remains unresolved and blocks unconditional release acceptance.
Passing browser runs or test reruns are not a fix. Chromium on
Linux and a test-certificate HTTPS proxy have been exercised; other engines,
physical devices, public certificate provisioning and your actual proxy/firewall
remain operator acceptance checks. Passing these commands is not a universal
security audit or a guarantee about an untested hosting environment.

## Workspace and commands

| Location             | Responsibility                                                                         |
| -------------------- | -------------------------------------------------------------------------------------- |
| `apps/api`           | Effect HTTP services, SQLite/filesystem adapters, typed configuration and operator CLI |
| `apps/web`           | Svelte 5 admin, Bits UI, Tailwind, TanStack Query and HTTPS browser smoke tests        |
| `packages/shared`    | Browser-safe domain schemas and content rules                                          |
| `packages/contracts` | Shared Effect Schema/HttpApi contracts and DTOs                                        |
| `tools`              | Build/deployment verification and vendored anti-slop lint rules                        |

| Command                                                   | Purpose                                                                |
| --------------------------------------------------------- | ---------------------------------------------------------------------- |
| `pnpm dev`                                                | Start both development apps                                            |
| `pnpm check`                                              | Formatting, lint, type checks and Vitest suites                        |
| `pnpm test`                                               | Vitest suites only (no Docker/browser fixture)                         |
| `pnpm verify:v1`                                          | Disposable HTTPS browser/container/operator acceptance workflow        |
| `pnpm build`                                              | Build admin, server and compiled CLI entries                           |
| `pnpm --filter @zupka/api start`                          | Run the compiled service; use production env from the deployment guide |
| `pnpm --filter @zupka/api owner:create` / `owner:recover` | Interactive source-checkout owner operations                           |
| `pnpm --filter @zupka/api content:migrate <version>`      | Explicit configured source data conversion                             |
| `pnpm lint` / `pnpm typecheck`                            | Run individual engineering checks                                      |
| `pnpm format` / `pnpm format:check`                       | Format or check formatting                                             |

Vite+ owns build/test/lint/format tooling. Shared TypeScript source is bundled for
browser/server entries; runtime dependencies and generated chunks must accompany
the compiled API. Effect-aware `tsrs` checks TypeScript; `svelte-check` additionally
checks Svelte components. Query owns admin reads/cancellation and cache identity;
mutations do not automatically retry, and protected caches clear on logout/session
loss. See the implementation and tests before changing these boundaries.
