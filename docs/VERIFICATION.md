# CMS v1 verification and acceptance

## Reproduce the checks

From the configured source checkout, using Node 26.x / pnpm 12.14.0:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm exec playwright install chromium
pnpm verify:v1
```

The opt-in acceptance command requires Linux Docker, Python **3.12+**, OpenSSL,
and the installed Playwright Chromium browser/system libraries. On a minimal
Linux machine, use Playwright's documented system-dependency installation process;
review privileged package-install commands before running them. It builds local
images and downloads base images/dependencies; allow time and disk space.

`pnpm check` does not require Docker or a browser installation. It also typechecks
`apps/web/e2e/*.ts`; those tests run separately through `pnpm verify:v1`, not Vitest.
No check is disabled, weakened or automatically retried to obtain a passing result.

`tools/verify-deployment.py --browser` creates a source-only temporary checkout,
opts into the documented Talks example **only in that copy**, and builds the
production Dockerfile. A second disposable container terminates real TLS and
forwards unchanged requests to the service over a private Docker network.
Chromium navigates the compiled admin through that HTTPS proxy; there is no Vite
server, HTTP route interception, synthetic session injection or in-memory storage.
The test certificate is self-signed: Playwright bypasses certificate-chain errors
for this fixture, not cookie, Origin, CSRF or TLS behavior. Host trust stores are
not changed. The test configuration refuses non-localhost/non-HTTPS targets.

The command then tests the operator path on real on-disk SQLite/files: replacement
and rebuild, stopped whole-volume backup, rebuild from matching backed-up source,
fresh-volume restore/integrity, recovery invalidation and an explicit compiled
migration. The migration fixture renames Summary to Abstract in a disposable
source copy, verifies incompatible-startup rejection, performs the conversion,
rejects replay, and verifies preserved content/image access. It never adds a
migration or changes definitions in the owner's checkout.

Only generated containers, volumes, network and image tags are removed. Docker
build caches may remain. No public registry pushes, host firewall changes, host
certificate installation or existing CMS volume access occur.

For just the HTTP packaging/restore slice:

```sh
python3 tools/verify-deployment.py
```

## Evidence by behavior

The complete local verification run passed **118 Vitest tests**, the production
build, and the HTTPS Chromium/container/operator acceptance command. The pre-edit
step-12 baseline also passed all 118 tests and the build. A later full run and one
isolated file run reproduced the pre-existing intermittent 401 described below.
Subsequent passing runs do not resolve it. No auth-policy workaround, weakened
assertion, automatic retry or enlarged test timeout was introduced.

| Approved behavior                                                                                                                                                        | Verification seam                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Every field kind, malformed definitions, defaults only at creation, incomplete drafts vs required publications, normalized dates/slugs                                   | `packages/shared/src/content.test.ts`, API configuration tests; real-browser Post/Project/Talks workflow                                   |
| Durable identity, per-type unique slugs, immutable publication history, safe configuration additions and rejected incompatible changes                                   | `content-storage.test.ts`, `entry-http.test.ts`, `publication-http.test.ts`; packaged rebuild/restore/migration checks                     |
| Password sign-in/logout, single owner, durable/revocable sessions, native hashing/rate limits, CSRF/Origin and private authority                                         | `auth-sqlite.test.ts`, `auth-http.test.ts`, `owner-security.test.ts`; packaged hidden prompts and HTTPS browser cookie/admission checks    |
| Draft CRUD, title search, bounded pagination, state filters, optimistic writes and transactional rollback                                                                | `entry-http.test.ts`, web component tests; real-browser save, filter/search, separate-writer conflict and deletion                         |
| Verified four-format uploads, streaming limits, private GET/HEAD/conditional reads, cancellation, missing-file/race handling and guarded deletion                        | `image-http.test.ts`, shared parsed-reference tests; real-browser forged/valid upload, private preview and image deletion conflict         |
| Saved/publication independence, publish/republish/unpublish, shared image visibility, locked slugs, racing transitions and deletion                                      | `publication-http.test.ts`; browser publication cycle, anonymous reads before/after transitions and conditional private HEAD               |
| Public DTO projection, Markdown source/image alt text, ordering/ties/pagination, custom types, CORS/error/cache separation                                               | `public-content-http.test.ts`; anonymous HTTPS Post/Project/Talks delivery and restored image bytes                                        |
| Generated controls, safe preview/XSS input, preserved list items, required-field feedback, stale comparison, unsaved-navigation confirmation and session/input retention | Web editor/image/preview/component suites; HTTPS browser keyboard saves, negative inputs, offline failure and logout/401/re-authentication |
| One-origin static serving, deep-link reload, MIME/HEAD, unknown APIs remain errors, no storage/traversal/symlink exposure                                                | `admin-http.test.ts`; compiled-admin HTTPS navigation and unknown API checks                                                               |
| Non-root runtime, shipped CLI/native dependencies, persistence across replacement/rebuild, backup/restore and recovery                                                   | `tools/verify-deployment.py` against generated containers/volumes and compiled CLI entries                                                 |
| Explicit migration validates both snapshots, preserves history, versions sequentially and rolls back failures                                                            | `content-storage.test.ts`, image-reference migration tests; packaged successful rename and replay/incompatible-startup failures            |

Negative browser cases include anonymous management/private-image access, missing
CSRF, foreign Origin, forged PNG, invalid Project URL, missing required custom
field, script/raw-HTML/unsafe-link preview input, duplicate and locked slugs,
invalid field types, stale saves, published-entry deletion and referenced-image
deletion. Expected failures are asserted as failures; they do not get counted as
successful writes. Existing real-router suites additionally cover oversized,
truncated/decompression-heavy uploads, injected late failures and connection races
without relying on browser timing.

## Visual and keyboard evidence

The acceptance workflow captures full-page 1440×900 and 390×844 Chromium views in
ignored `test-results/browser/`. Captures cover login/focus/error, empty and long-title
lists, Post/Markdown preview, saved/publication differences, custom controls,
field validation, network/session loss, stale comparison and reference conflicts.
The shipped Gallery Index surfaces were visually inspected at desktop and narrow
sizes. Text/actions/errors wrap without page-level horizontal overflow; the test
asserts overflow at each capture. Native single-line inputs scroll their own long
values, while list titles and snapshot text wrap.

Keyboard checks exercise the skip link, focused editor entry, Enter-to-save and
Enter-to-open, plus deliberate feedback/image-picker/return focus. Native confirm
is exercised for permanent deletion and cancelled unsaved navigation. No new UI
redesign or styling change was needed during this verification step.

Screenshots contain **synthetic fixture content only**, remain local and are not
committed. Request traces, videos, credential/session dumps and browser storage
state are not recorded. Do not adapt this fixture to a real owner volume or use
real passwords in test artifacts.

## Limits and operator acceptance

**Release-acceptance blocker: intermittent authenticated 401.** An existing
`entry-http.test.ts` session occasionally receives 401 where a valid-owner request
should produce 400/409/200. This was also recorded in step 11. During step 12,
`pnpm check` reproduced it (117/118 passed), and
`pnpm exec vp test run --project api apps/api/src/entry-http.test.ts` reproduced it
once in about five seconds. Later repeated file runs, four full Vitest runs and a
throwaway 4,000-authenticated-read probe passed. Temporary content-free diagnostics
did not capture another failure and were removed; the probe was not retained as
a false-confidence regression test. The root cause remains unconfirmed. Do not
assume this is test-only: an unexpected 401 could end a real owner's session.
Resolve and lock down the cause before claiming unconditional release acceptance.
The original tests/policy remain intact; passing reruns are evidence, not a fix.

The remaining evidence is bounded verification, not an independent security audit
or a guarantee for every environment. Additional acceptance limits are explicit:

- Verified platform: Linux x86-64/glibc, Node 26.12.1, Chromium with Playwright
  1.64.1. Firefox, WebKit, other architectures and physical touch devices were not
  exercised. Narrow screenshots are viewport emulation, not a device test.
- The local proxy proves real TLS transport, Secure-cookie browser use, same-origin
  navigation and unchanged Origin/CSRF admission. It does **not** provision public
  DNS/certificates or test your actual Caddy/nginx/CDN/firewall configuration.
  Verify trusted-origin settings, HTTPS-only reachability and absence of proxy
  response caching on your deployment before exposing it.
- Keyboard/focus/overflow checks are not a complete assistive-technology or WCAG
  audit. Perform screen-reader and device-specific acceptance as needed.
- Operator-managed backups require a maintenance window with **all writers
  stopped**, matching source/configuration and protected backup storage. Restore
  a real backup periodically; do not infer recoverability from a successful copy.
- Rate limits are process-local; one service/volume is supported. No distributed
  coordination, automatic backup service or automatic content conversion is added.
- Session loss retains unsaved input only in the current tab. Published copies
  downloaded or independently cached by consumers cannot be recalled.

Before switching production traffic, follow [deployment/maintenance](./DEPLOYMENT.md):
check health, owner login/logout/recovery, a private image, a published entry/image,
unpublish visibility and a backup restore. Keep previous matching data/source
until the replacement is accepted. Review the [spec](./SPEC.md) and
[roadmap](./ROADMAP.md) rather than treating future features as v1 requirements.
