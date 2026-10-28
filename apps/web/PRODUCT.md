# Zupka

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One owner per deployment manages content for independently built portfolio sites. The CMS is reusable; informati.dev is an intended consumer, not a product-specific constraint.

## Product Purpose

Provide a private admin for authoring and explicitly publishing content, and a public, read-only API for separate sites. Success means the owner can manage content without coupling portfolio presentation to the CMS.

## Operating Context

Source-based, self-hosted adoption: clone the repository, configure content types in code, build, and deploy. Configuration changes require a restart or redeploy. V1 targets one persistent server/container with SQLite and local image storage, not ephemeral hosting. Production single-service packaging remains planned, not verified.

The admin uses Svelte 5, Bits UI, Tailwind, TanStack Query, and Effect. The backend uses Effect and Yielded Auth. Owner provisioning and password recovery are local operator commands; there is no public signup or password-reset flow.

## Capabilities and Constraints

- Built-in Posts and Projects; additional content types and fields are defined in code. No visual schema editor in v1.
- Every entry requires a title and a per-content-type unique slug. Slugs become immutable after first publication, including after unpublishing.
- Working drafts and published versions are independent. Saving does not publish. Explicit publication replaces the public version; unpublishing removes availability without deleting the draft.
- Entry lists support title search, pagination, and publication-state filters. No dashboard or analytics in v1.
- Generated editors, safe Markdown preview, and an authenticated image library extend the admin shell and entry lists. See `../../docs/CONTENT_EDITING.md` for the step-10 workflow and verification limits.
- Field kinds: text, number, boolean, date/time, URL, Markdown, image, fixed-choice select, and text lists. Effect Schema is the validation source of truth.
- Explicit save and publish actions; no autosave or revision history. Unsaved changes must not be silently lost.
- Verified JPEG, PNG, WebP, and GIF uploads up to 10 MiB. New images are private; current published references determine public access. Referenced images cannot be deleted.
- Deletion is permanent, requires confirmation, and requires entries to be unpublished first.
- Public delivery is paginated REST/JSON with Markdown source and image URLs/alt text. Consuming sites own rendering and rebuild behavior.
- The admin is English in v1. Content may be written in any language; structured multilingual content is out of scope.
- Multi-user accounts, relationships/nested groups, executable MDX, scheduled publishing, manual ordering, and GraphQL are outside v1.

## Evidence on Hand

- Approved requirements: `../../docs/SPEC.md`.
- Terminology: `../../GLOSSARY.md`; use Owner, Content type, Entry, Draft, and Published version consistently.
- Implementation scope and verification evidence: `../../docs/IMPLEMENTATION_PLAN.md`.
- Existing real-router, SQLite/filesystem, schema, and component tests provide engineering evidence, not a production-readiness claim.
- The admin uses the approved charcoal-and-orange reference direction, with shell/lists and generated editors/image management implemented. Step-10 real-owner browser checks use loopback HTTP with temporary storage, not a production container or HTTPS deployment.

## Product Principles

- Keep content management independent of portfolio presentation.
- Make draft versus public content explicit and protect private content.
- Preserve content and surface conflicts rather than silently overwriting or migrating it.
- Keep the single-owner workflow focused; do not add team or platform features.

## Accessibility & Inclusion

Admin workflows must support keyboard operation, clear labels and errors, deliberate focus behavior, narrow viewports, and long content titles.

## Brand Commitments

The owner confirmed a dark-only admin, then approved a charcoal-and-orange redesign based on supplied editor and list mockups, using Lucide Svelte icons throughout. Its durable visual rules are recorded in `DESIGN.md`; screen-specific composition belongs in the admin surface brief.
