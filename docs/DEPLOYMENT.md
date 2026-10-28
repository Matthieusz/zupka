# Single-service deployment and maintenance

Build from your configured source checkout, not a prebuilt CMS image. One Node 26
container serves the compiled admin and Effect API; your reverse proxy terminates
HTTPS. SQLite and private images live together on a durable local volume. Do not
run multiple service replicas against this volume or use ephemeral/serverless disk.

## Build and first owner

Requires Docker with Linux containers. The verified platform is Linux x86-64/glibc;
other architectures have not been exercised. Source tooling requires Node 26 and
pnpm 12.14.0; the multi-stage Docker build installs its own pinned tooling.

1. Edit `apps/api/src/content-config.ts` and any imported definitions. See
   [configuration](./CONTENT_CONFIGURATION.md). Run `pnpm check` before deploying.
2. From the repository root:

   ```sh
   docker build -t zupka:local .
   docker volume create zupka-data
   ```

3. Store the following outside the checkout in a private operator-owned file,
   for example `/absolute/private/zupka.env` (mode 600). Replace the example origin:

   ```dotenv
   AUTH_ORIGIN=https://cms.example.com
   PUBLIC_READ_ORIGINS=https://portfolio.example.com
   ```

   `PUBLIC_READ_ORIGINS` defaults to `*`, or accepts comma-separated exact HTTP(S)
   origins; it never enables credentialed admin CORS. `AUTH_ORIGIN` must be the
   exact HTTPS origin, without a trailing slash/path. Do not put passwords in this file.

4. Provision the sole owner **before** starting the service:

   ```sh
   docker run --rm -it --env-file /absolute/private/zupka.env \
     -v zupka-data:/data zupka:local node dist/owner.mjs create
   ```

   Enter the email and hidden password/confirmation. No password arguments,
   environment variables, redirected input, or public setup endpoint are supported.

5. Run one service, exposing HTTP only on the proxy host's loopback interface:

   ```sh
   docker run -d --name zupka --restart unless-stopped \
     --env-file /absolute/private/zupka.env \
     -p 127.0.0.1:3001:3001 -v zupka-data:/data zupka:local
   curl --fail http://127.0.0.1:3001/api/health
   ```

   Keep the env file and volume across container replacement. Never use `docker
   volume rm` to upgrade or recover a password. Do not publish port 3001 on all
   host interfaces. Open the admin only through the configured HTTPS origin.

The runtime uses UID/GID 1000 (`node`), not root. A new named volume inherits the
image's private `/data` directory. A bind mount must already be owned by that UID
and writable, with mode 700; the container does not elevate privileges or repair
host permissions. The image has production dependencies, native Sharp/libvips,
Yielded Auth, SQLite support, bundled shared schemas, all CLI entries/chunks, and
`dist/public`. It does not require pnpm, tsx, or a source checkout at runtime.
Docker ignore rules exclude dependencies, build output, environment files, local
SQLite files, uploads and UI captures from the build context.

## HTTPS reverse proxy

For example, Caddy on the same host (with DNS pointing at it):

```caddyfile
cms.example.com {
    reverse_proxy 127.0.0.1:3001
}
```

The operator owns DNS, certificates, proxy installation and firewall policy. For a
containerized proxy, use a private Docker network and the service's internal port
instead; never use the proxy container's own loopback to reach another container.

Preserve Host, Origin, cookies and `x-effect-auth-csrf` headers. Do not rewrite all
404s to `index.html`, intercept API errors, mount uploads, or expose the data
volume from the proxy. Disable proxy/CDN response caching for this origin,
especially `/api`, images and authenticated responses. Do not log request bodies,
passwords, cookies or authorization headers. Apply connection/request limits as
defense in depth; do not replace the application's Origin/CSRF admission checks.

Production requires explicit HTTPS `AUTH_ORIGIN`; a plain HTTP production origin
fails startup. Cookies are Secure, HttpOnly, host-only, SameSite=Strict. Forwarded
headers do not grant authority. A direct HTTP curl can check health but is not a
substitute for real HTTPS browser verification. See [authentication](./AUTHENTICATION.md).

## Runtime/build layout

| Setting         | Container default                | Meaning                                                      |
| --------------- | -------------------------------- | ------------------------------------------------------------ |
| `NODE_ENV`      | `production`                     | Requires HTTPS admin origin                                  |
| `HOST`          | `0.0.0.0`                        | Listen inside the container; host publication stays loopback |
| `PORT`          | `3001`                           | HTTP listener                                                |
| `DATABASE_PATH` | `/data/zupka.sqlite`             | Shared server/CLI database                                   |
| `UPLOADS_PATH`  | `/data/uploads`                  | Private immutable image bytes                                |
| `ADMIN_DIST`    | beside main entry: `dist/public` | Built public admin only, never a storage directory           |

Keep the storage defaults for the commands in this guide. If overridden, pass the
**same absolute paths** to server and every operator command and adapt backups to
include both locations. Missing/unreadable admin builds or asset symlinks fail
startup. Only `index.html` and `assets/` enter the public build snapshot; it never
resolves a request against the filesystem. API errors stay API errors, missing
assets return 404, and extensionless HTML navigations can return the SPA shell.
The current admin uses hash deep links, which also work on reload. GET/HEAD serve
public assets with correct types, `nosniff` and `no-store`; private bytes always
pass through the existing access-checked image route, including conditional reads.

For a non-container local production-shaped run:

```sh
pnpm install --frozen-lockfile
pnpm build
# Create /absolute/data first; retain production dependencies in node_modules.
NODE_ENV=production AUTH_ORIGIN=https://cms.example.com \
DATABASE_PATH=/absolute/data/zupka.sqlite UPLOADS_PATH=/absolute/data/uploads \
  pnpm --filter @zupka/api start
```

The build copies the web output into the API package. Source development still
uses Vite unless `ADMIN_DIST` is explicitly set. The Node runtime owns HTTP/SQLite
scopes and interrupts them on SIGTERM/SIGINT. Use `docker stop --time 30 zupka`,
not SIGKILL. Effect's normal finalized signal interruption currently exits 130;
exit 137 indicates a forced kill, not the verified graceful path.

## Maintenance-window backup

**Stop every writer for the entire procedure**: the service and any owner/migration
CLI processes. Do not copy only a live `.sqlite` file. WAL may hold committed
content that is absent from that file; images and references also need one
consistent point in time. This procedure archives the whole stopped data volume,
including any WAL/SHM/journal files, and the exact matching configured checkout.

Use a fresh, private backup directory **outside the checkout**; do not overwrite
an existing backup. Backups contain password hashes, sessions and private content:
restrict access, encrypt/offsite-store them as appropriate, and test restores.

```sh
# Run from the exact checkout used to build the running image.
umask 077
BACKUP=/absolute/private/zupka-backup-2026-07-20
mkdir "$BACKUP"
docker stop --time 30 zupka
# Confirm it stopped without a forced kill, and confirm no CLI writers remain.
docker inspect --format '{{.State.Running}} {{.State.ExitCode}}' zupka

docker run --rm -v zupka-data:/data:ro zupka:local \
  tar -C /data -cpf - . > "$BACKUP/data.tar"
# Include uncommitted configuration and imported migration/definition modules too.
# Keep actual storage outside the checkout; adjust exclusions for any custom paths.
tar --exclude='.git' --exclude='node_modules' --exclude='dist' \
  --exclude='.vite' --exclude='coverage' --exclude='.impeccable' \
  --exclude='uploads' --exclude='data' --exclude='backups' \
  --exclude='*.sqlite*' --exclude='.env' --exclude='.env.*' \
  -czf "$BACKUP/checkout.tar.gz" .
cp /absolute/private/zupka.env "$BACKUP/runtime.env"
docker image inspect zupka:local > "$BACKUP/image.json"
(cd "$BACKUP" && sha256sum data.tar checkout.tar.gz runtime.env image.json > SHA256SUMS)
# Only resume after every archive/copy/checksum command succeeded.
docker start zupka
```

If a backup command fails, do not treat the archive as usable. Inspect the failure
and repeat into a new directory while writers remain stopped. A source archive
and lockfile preserve configuration/build inputs, not perpetual registry access;
optionally retain an operator-managed export of the exact local image as well.

## Restore into a fresh volume

Do not restore over a live or populated volume. First verify checksums and unpack
the matching source/configuration into a new checkout. Build that configuration,
not today's edited configuration:

```sh
(cd "$BACKUP" && sha256sum -c SHA256SUMS)
mkdir /absolute/restored-checkout
tar -xzf "$BACKUP/checkout.tar.gz" -C /absolute/restored-checkout
docker build -t zupka:restored /absolute/restored-checkout
docker volume create zupka-restored
# Fresh volume inherits /data ownership; restore as the same unprivileged UID.
docker run --rm -i -v zupka-restored:/data zupka:restored \
  tar -C /data -xpf - < "$BACKUP/data.tar"
docker run --rm -v zupka-restored:/data zupka:restored node --input-type=module -e \
  "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('/data/zupka.sqlite'); if (db.prepare('pragma integrity_check').get().integrity_check !== 'ok') process.exit(1); db.close();"
```

Start a replacement container with `zupka:restored`, the restored env file, and
`zupka-restored:/data`, using the run command above. Keep the old service stopped
when reusing its port/origin. Check health, owner sign-in, draft and publication
content, public API, and private/public image access before switching traffic.
Retain the original backup and volume until verification is complete. Restored
sessions can still be valid; run local owner recovery if all should be revoked.

## Recovery, configuration changes and upgrades

- **Forgotten password:** stop the service, take the backup above, then run
  `docker run --rm -it --env-file /absolute/private/zupka.env -v zupka-data:/data zupka:local node dist/owner.mjs recover`.
  Enter the existing owner's email/new hidden password. Restart; old sessions and
  password are invalid. Do not delete storage or create another owner.
- **Safe configuration edit:** back up the old source/data pair, edit and check the
  checkout, build a new local tag, stop/remove only the old container and recreate
  it with the same volume/env file and new tag. Startup checks compatibility;
  defaults are not backfilled. Keep the prior image/tag and matching source.
- **Incompatible edit:** provide/review/test an explicit conversion in
  `apps/api/src/content-data-migrations.ts`; see [storage/migrations](./CONTENT_STORAGE.md).
  Keep the service stopped and back it up before running the new image's
  `node dist/migrate-content.mjs <configured-version>` with the same volume/env
  (`docker run --rm ... zupka:new node dist/migrate-content.mjs 1`). Startup never
  runs these conversions automatically; the default registry is empty, so version
  1 is intentionally rejected until configured. Restart only with matching target
  definitions. Do not run owner commands before a required conversion.
- **Upgrade:** review changes, preserve local definitions/migrations, test/check/build,
  stop and back up, run any explicit conversion, then replace the service. Verify
  health, sign-in, publication and image access. DDL/adoption run at startup; do
  not assume an old image can read an upgraded database. Roll back by restoring
  the complete old data/source pair into a fresh volume, not by mixing versions.

## Verification evidence and limits

`python3 tools/verify-deployment.py` is an opt-in disposable Docker smoke test. It
builds a source-only checkout, uses the shipped interactive create/recover CLI
without password echo, signs in with production cookie flags, exercises the native
image decoder and publication, replaces/rebuilds the container, stops it cleanly,
archives/restores the full volume, checks SQLite integrity, then verifies restored
sessions, definitions, drafts/publications, image bytes, unpublish visibility and
recovery invalidation. It also exercises the packaged migration command's truthful
unconfigured-version failure. It removes only its own generated resources.

For the full v1 acceptance workflow, install the pinned browser with
`pnpm exec playwright install chromium`, then run `pnpm verify:v1`. This adds a
real local TLS reverse-proxy container and Chromium owner/visitor workflows, opts
into Talks only in the disposable checkout, and verifies a successful compiled
migration after incompatible-startup rejection. Python 3.12+, OpenSSL, Docker and
the installed workspace/browser dependencies are required. See the
[verification record and limits](./VERIFICATION.md).

Real-router tests separately cover static/deep-link/HEAD behavior, missing assets,
unknown APIs, error preservation, traversal/storage denial and asset symlink
rejection. The lighter container test uses HTTP on loopback with explicit production
headers. The full acceptance command additionally verifies real HTTPS browser
cookies/CSRF/navigation against the shipped service, using a test certificate and
disposable proxy. Your public certificate/DNS, actual proxy/firewall, other browser
engines and physical devices still require operator acceptance; see
[verification limits](./VERIFICATION.md#limits-and-operator-acceptance).
