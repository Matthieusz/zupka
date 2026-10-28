# SQLite content storage and configuration changes

## Runtime storage

The server and local owner commands compose `StorageLive`: one scoped Effect
SQLite connection, WAL, foreign keys, existing owner migrations, versioned content
DDL, and content-configuration adoption. The same SQL client is provided to all
routes; authentication no longer opens its own database.

| Variable        | Default        | Meaning                                  |
| --------------- | -------------- | ---------------------------------------- |
| `DATABASE_PATH` | `zupka.sqlite` | Durable SQLite file                      |
| `UPLOADS_PATH`  | `uploads`      | Durable private image-directory location |

Relative paths resolve against the process working directory (pnpm package
commands run in `apps/api`). Prefer absolute paths for deployment and operator
commands. Parent directories must already exist. Blank paths, NUL bytes, SQLite
memory names/URIs, and a database lexically inside the upload directory are
rejected. The check does not canonicalize symlinks: operators must keep the
physical locations separate too. The [image module](./IMAGES.md) creates the
private image directory on upload and serves files only through access-checked
handlers, never a static directory mount.

The SQLite driver closes on scope exit and uses WAL. Native busy waits are disabled
because they block the Node event loop while another local transaction awaits a
filesystem check. Content transactions cooperatively retry only rolled-back SQL
lock failures at 10 ms intervals, at most 100 retries; revision/validation errors
and committed writes are never retried. Exhaustion remains a typed storage
failure. This is one-service local lock coordination, not distributed deployment
support. Explicit content conversions still require a maintenance window.
Do not copy a running SQLite file without its journaling state. A complete
[maintenance-window backup/restore procedure](./DEPLOYMENT.md#maintenance-window-backup)
covers the entire stopped data volume and matching configured source.

## Stored data and invariants

- `owner_migrations` retains the existing auth history without renumbering it.
- `content_sql_migrations` versions application-owned content DDL.
- `content_definitions` stores the accepted serializable definition per type.
- `content_entries` stores stable entry/type identity, unique per-type slug,
  revision, creation/update time, and independent first-publication history.
- `content_snapshots` stores separate draft and current-publication JSON snapshots.
  Content is decoded with both the shared content schema and the accepted
  definition-driven draft/publish schema.
- `content_images` stores immutable verified metadata and active/deleting state;
  files use generated names in the private persistent directory.
- `content_image_references` links image IDs to exact draft/published snapshots,
  cascading on snapshot deletion and restricting image deletion.
- `content_data_migrations` records explicit conversion versions and their exact
  source/target definitions.

Foreign keys, per-type slug uniqueness, revision checks, snapshot constraints,
and identity/slug/first-publication triggers back applicable domain invariants.
Deleting the current published snapshot does not clear first-publication history
or unlock its slug. There is no stored publication-status flag.

`insertStoredDraft` and `listStoredEntries` are local persistence seams, not
management routes. They accept/return schema-decoded content; insertion does not
apply defaults. Steps 5–6 add [authenticated draft management](./DRAFT_MANAGEMENT.md),
optimistic saves, and [image-reference rules](./IMAGES.md). Content DDL migration
0002 adds image/reference tables without renumbering migration 0001. Publication
rows in storage tests remain explicit fixtures; step 7 separately adds the actual
[publish/unpublish workflow](./PUBLISHING.md) and publication-derived image access.

## Automatic compatibility checks

On startup, initialization validates existing content against its recorded
configuration, compares the proposed code definitions, validates every saved
draft/publication against the proposed definitions, then adopts definitions in
one write transaction. Image-reference sets are rebuilt from the validated
snapshots in that same transaction, rejecting missing files/images. Failure
preserves definitions, snapshots, and reference sets.

Safe changes include new types, optional fields (with or without defaults),
labels, default changes, loosening required flags, and extending select choices.
Old snapshots are never rewritten or backfilled with defaults.

Removing types/fields, changing kinds, tightening required flags, adding required
fields to an existing type, and removing select choices conservatively require
an explicit migration, even when a scan might find no currently conflicting
values. Errors identify the type/field or entry/snapshot requiring action.
Unknown fields and invalid persisted values are not silently discarded.

## Explicit data migrations

Normal startup never runs conversions. Add operator-authored migration objects to
`apps/api/src/content-data-migrations.ts`. Each has a sequential positive version
(starting at 1), a name, exact `from`/`to` definitions, and a pure per-snapshot
`transform`. Keep source/target definitions embedded or imported from immutable
versioned files, **not** from the mutable current deployment configuration.

For example, if a type previously had optional `summary` and now has optional
`abstract`, a complete migration object is:

```ts
{
  header: {
    version: 1,
    name: "rename-summary",
    from: [{
      id: "notes", label: "Notes",
      fields: [{ id: "summary", label: "Summary", kind: "text", required: false }],
    }],
    to: [{
      id: "notes", label: "Notes",
      fields: [{ id: "abstract", label: "Abstract", kind: "text", required: false }],
    }],
  },
  transform: (_entry, _kind, content) => {
    const { summary, ...rest } = content.fields;
    return {
      ...content,
      fields: summary === undefined ? rest : { ...rest, abstract: summary },
    };
  },
}
```

The source/target arrays must describe the **entire** accepted deployment
configuration, including unchanged types. Type order is normalized for source
comparison; field order and definition values must match the recorded source.

Operator sequence:

1. Stop the service and keep it stopped throughout conversion.
2. Take an operator-controlled, consistent backup of the database, image files,
   and matching configuration using the [deployment procedure](./DEPLOYMENT.md#maintenance-window-backup).
   Test each conversion on a disposable restored copy before production.
3. Add and review the next migration, test it against a copy using the real
   database migration path, and update the deployment's current definitions to
   its target.
4. Run the explicit version with the **same absolute storage paths** as the server:

   ```sh
   DATABASE_PATH=/absolute/data/zupka.sqlite UPLOADS_PATH=/absolute/data/images \
     pnpm --filter @zupka/api content:migrate 1
   ```

5. Restart with the matching target configuration. Startup validates it again.

The conversion validates old snapshots, converts drafts and publications
independently, validates every result with target schemas, increments entry
revisions, and commits snapshots, definitions, and the data-migration journal in
one transaction, including validation/replacement of managed-image references.
Failure or interruption rolls the transaction back. No defaults
are injected. Entry identity, slug, authored timestamps, and publication history
are retained. Replaying/skipping versions or applying against the wrong source
is rejected.

The content conversion seam supports field transformations; it is not an
automatic conversion engine. It cannot remove a type that still owns entries or
change entry identities/slugs. Changes requiring those operations need a
separately reviewed application/database migration. Image-reference transactions
are integrated with this seam; commands must use the same persistent image
directory as the server.

Source commands run through tsx. The production container ships
`node dist/migrate-content.mjs <configured-version>`; see
[container maintenance and upgrades](./DEPLOYMENT.md#recovery-configuration-changes-and-upgrades).
