# Content configuration

Edit `apps/api/src/content-config.ts`, then restart/redeploy. Startup decodes
the configuration with the browser-safe Effect Schemas in `@zupka/shared`;
duplicate identifiers, reserved fields, invalid choices/defaults, and unknown
properties are rejected.

Posts and Projects have required title/slug identity and optional built-in
fields. To add a custom field to Posts, append a field to `Posts.fields`:

```ts
{ id: "featured", label: "Featured", kind: "boolean", required: false, default: false }
```

To enable the included custom-type example, add `TalksExample` to the array
passed to `parseContentConfiguration`. Custom types need not include body,
summary, or images.

## Field definitions

All fields have `id`, `label`, `kind`, and `required`; `default` is optional.
Identifiers use lowercase ASCII words separated by hyphens. Identity, snapshot,
and prototype-related names are reserved. Select fields also require a nonempty
array of unique, nonblank string `choices`.

| Kind               | Value                                                                    |
| ------------------ | ------------------------------------------------------------------------ |
| `text`, `markdown` | String                                                                   |
| `number`           | Finite number                                                            |
| `boolean`          | Boolean                                                                  |
| `datetime`         | ISO timestamp including seconds and explicit timezone; normalized to UTC |
| `url`              | Absolute HTTP/HTTPS URL                                                  |
| `image`            | `{ imageId: "<UUID>", alt: "..." }`                                      |
| `select`           | One of the configured choice strings                                     |
| `text-list`        | Array of strings                                                         |

Required means present; empty text/lists are valid values. Title and slug are
always required and nonempty. Slugs allow lowercase Unicode letters/numbers
separated by hyphens. `suggestSlug` is deterministic and falls back to `entry`;
uniqueness and post-publication slug locking belong to later persistence and
publication steps.

Entry content is `{ title, slug, fields: { ... } }`.
`entrySchemas(type)` builds draft and publication schemas from one definition.
`parseEntry` rejects unknown fields and validates every supplied value; drafts
can omit required custom fields, publications cannot. `createDraft` additionally
applies defaults only on creation, preserving explicit false, zero, empty strings,
and empty lists. Ordinary parsing never backfills defaults.

Definitions are themselves the safe serializable admin description: encode with
`ContentConfiguration`, transport as JSON, decode with
`parseContentConfiguration`, then call `entrySchemas` or `fieldValueSchema`
in the admin. No server configuration import is necessary. This step supplies
the shared contract and rebuilding mechanism, not an admin HTTP route or editor.

Draft/publication envelope schemas validate identity and serializable snapshot
data; content must additionally pass the configured entry schema at its boundary.
These definitions do not yet check image existence or cross-entry invariants.
SQLite compatibility checks and explicit migrations are implemented in step 3;
see [storage and configuration changes](./CONTENT_STORAGE.md). Startup rejects
incompatible edits rather than rewriting or discarding existing content.
