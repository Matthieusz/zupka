# Anti-slop provenance

- Source: [Dillon Mulroy's anti-slop](https://github.com/dmmulroy/anti-slop).
- Installed from the local `install-anti-slop` skill's bundled assets, without modifying rule code.
- Entry points: `index.ts` and `effect/index.ts`.
- Exact originating commit of the bundled snapshot: **unknown**.
- Recoverable pristine snapshot: the installed assets and `SNAPSHOT.sha256`.
  Verify from this directory with `sha256sum -c SNAPSHOT.sha256`.

The bundle was compared using Git blob hashes against upstream commit
`13909c9e07590f5a85d93c62712259fe14a883f7`. 35 of 38 bundled files match.
These bundled files differ, so that revision is **not** claimed as the source
of the complete snapshot:

- `rules/require-readable-spacing.ts`
- `vendor/eslint-stylistic/padding-line-between-statements.ts`
- `vendor/eslint-stylistic/UPSTREAM.md`

The upstream MIT `LICENSE` was added from that explicit revision.
The nested Stylistic license and provenance are retained.
Intentional project deviations: none in rule implementation; all generic and
Effect rules are enabled at error severity. Vendored assets are excluded from
application linting and formatting.

Current limitation: the Effect service-import rule checks relative project
imports, not workspace/package aliases.
