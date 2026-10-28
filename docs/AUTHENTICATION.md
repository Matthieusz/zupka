# Owner authentication and local operations

Zupka has one local owner. Yielded Auth provides password verification and durable
stateful sessions in the same SQLite database as content. There is no public
registration, setup, password recovery, or email-reset flow.

## Provisioning and recovery

Run from the source checkout with Node 26 and pnpm:

```sh
DATABASE_PATH=/absolute/data/zupka.sqlite UPLOADS_PATH=/absolute/data/images \
  pnpm --filter @zupka/api owner:create

DATABASE_PATH=/absolute/data/zupka.sqlite UPLOADS_PATH=/absolute/data/images \
  pnpm --filter @zupka/api owner:recover
```

Use the same storage paths as the server. Parent directories must already exist.
The commands require an interactive terminal, prompt for email and a hidden
password/confirmation, and accept no password arguments, environment variables,
or redirected password input. Passwords are 12–1024 characters; bytes are
preserved without implicit Unicode normalization. Keep database files, journals,
and operator access private. Never delete the database to recover a password.

Creation hashes with Yielded's native scrypt implementation and atomically writes
owner identity and credentials. A unique database index prevents a second owner,
including racing operator commands. Only the application-owned `owner` subject
can receive owner claims.

Recovery requires the existing owner's email. It hashes the replacement, then
atomically updates password/credential/security revisions and removes all old
sessions. Failure leaves existing credentials and sessions unchanged. Logout
revokes the current session; recovery revokes all sessions. Neither operation
relies only on clearing a browser cookie.

Source commands use tsx. The production container ships compiled
`node dist/owner.mjs create` and `node dist/owner.mjs recover` entries with the
same interactive-only policy. See [deployment and maintenance](./DEPLOYMENT.md)
for volume paths, recovery, and tested backup/restore commands.

## HTTP policy

Only these auth operations are mounted, all under `/api/auth`:

- `POST /signIn`: `{ "payload": { "email": "...", "password": "..." } }`
- `POST /getSession`: inspect the current cookie session (anonymous returns null).
- `POST /signOut`: `{ "payload": {} }`

Use the shared Effect client for wire envelopes and schema decoding. Yielded's
extra `requireSession` and `renewSession` HTTP operations are deliberately omitted;
requiring a session remains an internal server operation.

`AUTH_ORIGIN` is the **one exact admin origin**, not a wildcard, URL path, or list.
In development/test it defaults to `http://127.0.0.1:5173`. Other HTTP origins are
allowed only for `localhost`, `127.0.0.1`, or `[::1]` loopback development.
`NODE_ENV` accepts `development`, `test`, or `production`; production requires an
explicit HTTPS origin:

```sh
NODE_ENV=production AUTH_ORIGIN=https://cms.example.com \
DATABASE_PATH=/absolute/data/zupka.sqlite UPLOADS_PATH=/absolute/data/images \
  pnpm --filter @zupka/api start
```

The listener can remain HTTP behind the operator's HTTPS reverse proxy. The
configured public HTTPS origin determines cookie security; forwarded headers do
not grant trust or disable checks. The proxy must preserve Origin and CSRF
headers, not fabricate them. It must not log request bodies, passwords, cookies,
or authorization headers. Do not expose the listener as an alternate public
plaintext login path.

HTTPS cookies are Secure, HttpOnly, host-only, Path=/, SameSite=Strict, and use the
`__Host-` prefix. Local HTTP uses unprefixed development cookies. Auth responses
and protected successful/denied responses are `Cache-Control: no-store`; proxies
must not override this or cache authenticated traffic.

All browser auth operations require the exact configured Origin, JSON content
encoding, and `x-effect-auth-csrf: 1`. The static CSRF header is an admission check,
not a secret; Origin validation and same-origin credential handling are also
required. No credentialed cross-origin CORS policy or native-header bypass is
installed. Public-read CORS will be a separate step 8 concern.

New sessions have a 12-hour expiry and seven-day absolute cap, with no automatic
renewal endpoint; sign in again when expired. Positive session caching is disabled,
so verification checks current durable authority. The maximum accepted issued
lifetime remains 30 days to validate sessions issued by the earlier scaffold;
those retain their encoded expiry. Run owner recovery to invalidate all existing
sessions when that is required.

## Mandatory management boundary

Register every management route group through `ownerRoutes` in
`apps/api/src/owner-http.ts`, including uploads and private image reads:

```ts
const ManagementRoutes = ownerRoutes(
  HttpRouter.addAll([HttpRouter.route("GET", "/api/admin/example", handler)]),
);
```

Do not register management handlers directly in the public router. The boundary
requires a current durable session belonging to subject `owner` with owner
claims before a handler executes, and supplies `CurrentOwner` to the handler.
GET/HEAD may omit Origin for direct navigation/private image loads, but an
explicit foreign Origin is denied. Other methods additionally require exact
Origin and CSRF admission, independent of encoding (including multipart).
Anonymous callers receive 401, foreign-origin/CSRF/owner denials 403, and session
availability failures fail closed with 503. Header/body claims are never authority.
OPTIONS is not an authentication bypass.

Steps 5–7 now mount real draft, publication, and image-management routes through
this boundary. `ownerRoutes` and conditional private-image reads share the scoped
`OwnerGuard` service: private GET/HEAD reuses the identical durable owner and
Origin checks, never an alternative cookie/bearer bypass. A current published
reference can authorize image bytes publicly without owner cookies/admin Origin;
this never authorizes entry drafts or image-library metadata. See
[publication visibility](./PUBLISHING.md) and [image operations](./IMAGES.md).

## Bounded work and sign-in limits

- Auth request bodies: 16 KiB; URLs: 2048 bytes.
- Hashing/verification input: at most 4096 UTF-8 bytes.
- Native scrypt keeps the verified Yielded profile, with bounded verifier work.
- One KDF runs at a time, at most two wait, and acquisition waits at most one
  second. Queue pressure fails rather than spawning unbounded password work.
- Yielded token buckets allow an initial burst of ten attempts per identifier
  and subject, refilling one token per 90 seconds (ten per 15 minutes).
- A global action bucket also limits rotating identifiers: burst 30, refilling
  one token per two seconds (30 per minute).

Attempts include successful sign-ins and failures. Unknown identifiers and wrong
passwords share the same public rejection. Rate-limit rejection does not reveal
account existence through a special response. Yielded may do bounded dummy KDF
work on denied attempts; the KDF gate independently bounds that work.

Limiter state is process-local and bounded by Yielded's store; restarting resets
it. This is a single-service v1, not a distributed/durable brute-force limiter.
An attacker can temporarily consume login availability. Use proxy-level request
and connection limits as defense in depth, without trusting arbitrary forwarded
client-address headers in application authorization.

## Verification

Real-router tests use temporary on-disk SQLite databases and production migrations.
They cover sign-in/restart/logout/recovery, multiple-session invalidation, rejected
origins/CSRF, Secure cookie flags, absent account-creation/recovery/extra-session
routes, anonymous private GET/HEAD and write denial, handler nonexecution on denied
writes, owner-subject enforcement, bounded hashing, oversized input, and actual
rate-limit exhaustion/refill. Limiter time is controlled through its production
service seam; authentication itself uses real SQLite engine time.

Create/recover prompts were also exercised in a real pseudo-terminal with a
throwaway database: neither password was echoed, and a second owner was rejected.
The [deployment smoke test](./DEPLOYMENT.md#verification-evidence-and-limits) also
exercises packaged prompts, cookies, persistence and backup/restore in Docker.
The [v1 acceptance workflow](./VERIFICATION.md) additionally verifies Secure
cookie use, browser Origin/CSRF admission, logout and retained-input re-authentication
through a real local HTTPS proxy and the packaged service. Test-certificate/browser
coverage does not replace acceptance of your deployed HTTPS/proxy configuration.
