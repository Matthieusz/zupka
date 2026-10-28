# Generated editors and the image library

Step 10 extends the existing Gallery Index admin without changing its visual system. Start with [admin workspace setup](./ADMIN_WORKSPACE.md). The server remains authoritative for validation, revisions, publication and image references.

## Author and publish

1. Choose a content type and **New entry**, or select an entry title to edit its saved draft.
2. Enter a title. Leaving the title control suggests an initial editable slug; subsequent title edits do not change it. Slugs become read-only after first publication, including after unpublishing.
3. **Include** controls distinguish an omitted custom field from an empty string, false, zero or an empty list. Required custom fields can be omitted from a draft, but not from publication. Creation defaults are prefilled; their inclusion is fixed until the first save because the server applies defaults on creation. They can then be omitted without reapplying defaults.
4. **Save draft** validates supplied fields with the shared Effect Schemas and saves only the working draft. Server failures leave authored input intact. Dates use timezone-explicit ISO strings and normalize to UTC. Text lists use individually labelled, removable items, preserving empty items and embedded newlines.
5. **Publish** acts only on the saved revision. Save any local edits first. Publishing additionally checks required fields and referenced images. **Unpublish** removes public availability without deleting the draft.
6. The publication state and changed-field summary describe the saved snapshots, not unsaved input. Expand **Saved draft** and **Published version** to compare their complete values. **Delete entry** is enabled only for an unpublished entry with no unsaved input and requires a native browser confirmation; deletion is permanent.

There is no autosave, automatic merge, revision history or scheduling. Editors are intentionally in-memory screens, not independently bookmarked routes. Return to the entry list to navigate to another content type.

## Keyboard shortcuts

While the editor has focus, use Ctrl on Windows/Linux or Cmd on macOS:

| Action                  | Shortcut         |
| ----------------------- | ---------------- |
| Save draft              | Ctrl/Cmd+S       |
| Publish saved draft     | Ctrl/Cmd+Enter   |
| Toggle Markdown preview | Ctrl/Cmd+Shift+P |
| Insert managed image    | Ctrl/Cmd+Shift+I |

Markdown commands target the focused Markdown field, or the first Markdown field when focus is elsewhere in the editor. Button tooltips also show the shortcuts. Preview requires an included field. Publish still requires a saved draft with no unsaved changes or conflict; shortcuts never save and publish in one step. Shortcuts do not act inside dialogs, during pending writes, or while the session is inactive. Saving a new entry also suggests its slug if it has not yet been edited.

## Markdown and managed images

Enable a Markdown field to author CommonMark and toggle **Preview Markdown**. The preview renders parsed nodes as Svelte elements, never HTML injection or executable MDX. Raw HTML is displayed as text; executable links are omitted. HTTP(S) and mail links are allowed. Only canonical managed-image URLs load images in this preview, preventing external-image tracking. Inline and reference-style links/images use the same policy. Public API consumers still receive Markdown source and own their rendering/safety policy.

Use **Images** in the workspace navigation for the library, or **Choose image / Insert managed image** inside an editor:

- Upload JPEG, PNG, WebP or GIF files up to 10 MiB. Uploads send raw bytes through the authenticated contract; the server independently verifies the bytes, size and decode limits.
- New images remain private. Same-origin preview requests use the current owner cookie; there is no public upload-directory mount or client-created public URL.
- Enter alt text before **Use image**. Image fields store their own image ID and alt text; Markdown insertion appends an escaped image destination with alt text to the selected Markdown field. Alt text does not mutate shared upload metadata.
- The library paginates 20 images at a time. Deleting tombstones offer **Retry deletion** after partial cleanup failures.
- **Delete image** requires permanent-delete confirmation. A saved draft or published reference blocks deletion. Remove the image from each saved draft and save; republish without it or unpublish any published version that still uses it, then retry. Removing an unsaved editor reference alone does not release a saved reference.

Removing an upload that is used only in unsaved editor input can make that input invalid; the server will reject the missing reference on save rather than commit broken content.

## Unsaved input, sessions and conflicts

**Back**, browser hash navigation and page unload warn before discarding unsaved input. Pending entry writes disable the editing controls and leaving the screen. Native browser confirmations preserve platform keyboard/focus behavior; browser unload prompts depend on the browser's user-interaction policy.

Session expiry, a management 401, sign-out or a session-check outage hides the editor without unmounting it. Private Query data is cancelled and removed after confirmed session loss/logout; authored input stays only in the mounted editor's memory, not local/session storage. Sign in again in the same tab to resume. This deliberately also retains the editor after explicit sign-out, with a warning when it contains unsaved input. Closing/reloading the tab discards that memory; it is not a durable recovery mechanism or protection from someone with access to the same browser profile.

A stale revision never advances the local revision or overwrites a newer draft. Writes are disabled after a conflict. **Load latest saved version** fetches a separate comparison without changing local input. Copy any work you want to keep, then explicitly confirm **Discard local input and use latest**. Only that action replaces the editor and its revision. Nothing is automatically merged.

A network/storage failure may mean a write succeeded but its response was lost. The UI does not retry mutations automatically or claim that nothing was saved. Inspect the latest saved version before retrying. For an uncertain first creation, check the entry list; per-type slug uniqueness prevents silently creating a duplicate under the same slug.

## Verification and limits

- `Editor.test.ts` exercises explicit commands, revision payloads/CSRF headers, independent publication content, locked slugs, confirmed deletion, schema/network/stale failures, unsaved navigation and mounted input across session loss/re-authentication.
- `ImageLibrary.test.ts` covers image-field/Markdown selection with per-use alt text, private preview URLs, deletion confirmation/reference conflicts and paginated library requests. `editor-model.test.ts` covers every field kind, creation-only defaults, normalization, omission and lossless text-list controls. `MarkdownPreview.test.ts` covers raw HTML/MDX, unsafe URLs, external-image omission and reference destinations.
- The existing real-router tests still exercise production migrations, SQLite/files, publication atomicity and server security; frontend tests use the production Query/client seams with controlled HTTP responses, not module mocks.
- Chromium was also driven through a real loopback HTTP owner workflow against production routers, temporary on-disk SQLite/files and a Vite frontend. It covered a Post, a Project and the opt-in Talks configuration, all nine field kinds, upload/preview, save/publish/edit/save/unpublish/delete, anonymous image visibility, reference-blocked and successful image deletion, a separate-writer conflict, and logout/401/re-authentication with retained input. Full-page 1440px and 390px captures were inspected; both editor sizes had no horizontal overflow.
- Local screenshots and the browser report are ignored under `apps/web/.impeccable/review/step10/`. The finish review was inline, not independent. New type-size detector advisories were resolved using the existing type ramp; pre-existing list/brand documentation advisories were left unchanged.

Verification: `pnpm check` passed (115 tests), `pnpm build` passed, and `git diff --check` passed. This is not production-readiness evidence: the browser workflow used loopback HTTP, not Secure cookies behind HTTPS, built single-service static routing, a reverse proxy or a container. The subsequent [v1 acceptance workflow](./VERIFICATION.md) now verifies the compiled
admin through a real local HTTPS proxy/container, with browser Secure cookies,
CSRF, all field kinds and negative cases. Its platform/operator limits are explicit.
