# CMS v1 — confirmed requirements

This document records settled requirements. Unlisted behavior remains undecided.

## Product scope

- Reusable, self-hosted headless CMS; informati.dev is an intended consumer, not a product-specific constraint.
- One owner per deployment, with a private Svelte admin interface and an Effect backend serving a content API.
- Public portfolio sites remain separate applications.
- Built-in Posts and Projects, extensible with custom fields and additional content types.
- Content types and fields are defined in code configuration for v1; editing forms are generated from those definitions. Configuration changes require a restart or redeploy.

## Built-in content types

- Posts and Projects both have title, slug, summary, Markdown body, and cover image.
- Posts additionally have a publication date and tags.
- Projects additionally have technologies, a live-site URL, and a repository URL.
- Only title and slug are required; the other built-in fields are optional.
- Additional portfolio-specific fields can be defined through code configuration.

## Languages

- Content can be authored in any language.
- Structured multilingual content, linked translations, localized fields/slugs, and a locale-aware API are outside v1.
- The admin interface is in English for v1.

## Entry identity

- Suggest an initial slug from the title.
- Slugs must be unique within a content type.
- Slugs can be edited until first publication; they are immutable afterward, including when an entry is unpublished.
- Editing a title does not change the slug.
- Redirect management is outside v1.

## Custom fields

- Custom content types also require title and slug, providing a consistent identity across all entries.
- Body, summary, and images are not mandatory for custom content types.
- V1 supports text, number, boolean, date/time, URL, Markdown, image, select with fixed choices, and lists of text.
- Tags and technologies use lists of text.
- Field definitions support a label, required/optional flag, optional default value, and fixed choices for select fields.
- Validate values by field kind. Custom validation code, conditional fields, and computed fields are outside v1.
- Defaults apply when creating an entry, not retroactively to existing content.
- Nested objects, arbitrary repeatable groups, and relationships between entries are outside v1.

## Validation

- Effect Schema is the source of truth for data validation and inferred types, including content configuration, field definitions and values, form/API payloads, and persisted data.
- Decode boundary input and use the parsed values; do not maintain parallel hand-written data validators or trust casts.
- Reuse schema-based validation in the admin, with the server remaining authoritative.
- Cross-entry and transactional invariants, such as slug uniqueness and publication/image-reference rules, remain enforced by application services and database constraints where applicable.

## Content schema changes

- Allow safe configuration changes, such as adding optional fields.
- Reject incompatible changes until an explicit migration is provided; assess compatibility against existing drafts and published versions.
- Never silently discard or convert existing content.
- No visual migration builder in v1.

## Content editing

- Long-form content is authored in Markdown with a preview.
- No executable MDX in v1.
- Use explicit Save draft and Publish buttons; no autosave in v1.
- Warn before leaving an editor with unsaved changes.
- Saving a draft requires title and slug and validates all supplied field values, but may omit required custom fields.
- Publishing additionally requires all configured required fields to be present and valid.

## Admin interface

- Login and logout.
- Entry lists per content type, with title search and publication-status filters.
- Generated editing forms with Markdown preview.
- Image library with upload and deletion subject to the image-reference safeguards.
- Clearly distinguish unpublished entries, published entries, and published entries with draft changes.
- No dashboard, analytics, or visual content-type settings in v1.

## Images

- Built-in image uploads, usable in Markdown and image fields.
- Accept JPEG, PNG, WebP, and GIF, up to 10 MiB per image.
- Verify actual file type and size server-side rather than trusting filenames or browser MIME types.
- SVG and arbitrary-file uploads are outside v1.
- Support alt text for images.
- No image-editing or transformation pipeline in v1.
- New uploads require owner authentication to access until referenced by a published version.
- Image visibility follows current published references: an image is publicly accessible only while at least one current published version references it.
- Saving draft edits does not remove public access to images used by the existing published version.
- Unpublishing an entry or republishing without an image makes that image private unless another current published version still references it.
- Previously downloaded or cached copies cannot be recalled.

## Publishing

- Each entry has a working draft and may have a published version.
- Saving changes updates only the draft, including when the entry is already published.
- Publishing explicitly replaces the published version with the saved draft; visitors continue seeing the previous published version until then.
- Unpublishing is an explicit owner action that removes the entry from public availability.
- Retain only the current draft and current published version; no revision history in v1.
- Scheduled publishing is outside v1.

## Deletion

- Entries must be unpublished before deletion.
- Images cannot be deleted while referenced by any saved draft or published version.
- Deletion requires confirmation and is permanent.
- No trash bin or automatic unused-image cleanup in v1.

## Ordering

- Default ordering is date-based, newest first.
- No built-in numeric order field or manual ordering UI in v1.
- Posts sort by their supplied publication date, falling back to their first-published timestamp.
- Projects and custom content types sort by their first-published timestamps.
- Editing or republishing does not reset the first-published timestamp or automatically move an entry to the top.
- A Post's optional publication date supports backdating; it does not schedule publication.

## Content API

- Published versions are readable through a public, read-only API without an API key.
- Drafts and all management operations require owner authentication.
- Separate portfolio sites can fetch published content at build time or runtime.
- Use REST/JSON with paginated lists by content type and entry lookup by content type plus slug.
- Lists use the default newest-first publication ordering.
- Responses provide Markdown source and image URLs with alt text; consuming sites render Markdown themselves.
- GraphQL and arbitrary custom-field queries are outside v1.
- Rebuild hooks, publication webhooks, and deployment-provider integrations are outside the app's scope. Consuming sites own their rebuild and refresh behavior.

## Authentication

- One local owner login using [Yielded Auth](https://yielded.dev/auth/) (`@yielded/auth`).
- Password-based authentication with secure cookie sessions; no public signup.
- Keep the admin frontend in Svelte. Yielded Auth documents a directly callable Effect HTTP client; its React/Atom examples do not require us to adopt React.
- Provide local CLI commands for initial owner creation and forgotten-password recovery.
- Read passwords through interactive prompts, not command arguments.
- No public signup/setup endpoints or email-based password recovery in v1.

### Verified integration notes

- The upstream package currently declares an Effect peer dependency of `^4.0.3`, which includes this workspace's Effect `4.0.6`; implementation compatibility still needs testing.
- The inspected upstream package version is `0.1.0-beta.46`. Pin and verify a released version when implementing.
- References: [passwords](https://yielded.dev/auth/guide/passwords/), [HTTP integration](https://yielded.dev/auth/guide/http-and-client/), [direct client calls](https://yielded.dev/auth/guide/client/#call-the-client-directly), [upstream package](https://github.com/yielded-dev/auth/blob/main/packages/auth/package.json).

## Deployment

- V1 targets a persistent server or container with durable disk storage across restarts and deployments.
- Serverless or ephemeral hosting is not a v1 target.
- Store content in SQLite and uploaded images in a directory on the persistent volume.
- Backups are operator-managed, with documented and tested backup/restore steps covering SQLite, uploaded images, and configuration.
- A maintenance-window backup procedure is acceptable for v1.
- No backup dashboard, scheduler, or cloud backup integration in v1.
- V1 adoption is source-based: clone this repository, edit the typed content configuration, then build and deploy an instance.
- Production runs as one locally built container serving the compiled Svelte admin and Effect API on the same origin.
- Use a persistent volume for SQLite and uploaded images. The public portfolio remains a separate application.
- The operator's reverse proxy handles HTTPS.
- Installing the CMS as a standalone versioned package or prebuilt image with externally supplied configuration is outside v1.

## Related documents

- [Implementation plan](./IMPLEMENTATION_PLAN.md)
- [Glossary](../GLOSSARY.md)
- [Headless, self-hosted scope](./adr/0001-headless-cms.md)
- [Code-defined content types](./adr/0002-define-content-types-in-code.md)
- [SQLite and local images](./adr/0003-sqlite-and-local-images.md)
- [Future plans](./ROADMAP.md)
