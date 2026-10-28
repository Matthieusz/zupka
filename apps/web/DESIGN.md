# Zupka admin design

## Direction

Dark charcoal and warm orange, following the owner's two supplied mockups. The first reference governs color and editor treatment; the second governs the navigation, search, and entry-table composition. This replaces the former aubergine/lilac Gallery Index direction.

Mode: Operate. Preserve configured content types, explicit draft/publication semantics, omitted optional fields, image privacy, confirmation safeguards, and session handling.

## Tokens

Defined in `src/app.css`, in OKLCH:

- Background: `oklch(19% 0.002 70)`; sidebar: `oklch(18% 0.002 70)`.
- Raised surface: `oklch(21% 0.002 70)`; foreground: `oklch(96% 0.002 70)`.
- Supporting text: `oklch(74% 0.006 70)`; accent: `oklch(78% 0.15 58)`.
- Green published, amber changed, red destructive/error states, always accompanied by words.
- Orange-derived selection fill, subtle foreground-derived rules, 0.5rem control corners.
- System sans typography; monospace only for Markdown source and serialized snapshots.

## Composition

A shared 15rem sidebar carries the Lucide Soup wordmark, configured content-type links, Images, and owner/sign-out controls. Active navigation has a warm tinted fill and orange edge. On narrow screens the sidebar becomes wrapping navigation above the workspace.

Lists have a top search trigger, icon-led title and creation action, title-search and publication-state filters, and a bordered table-like list. Ctrl/Cmd K or the trigger opens a Bits UI Dialog/Command palette with debounced, server-backed title search across configured content types, arrow-key navigation, Enter to open, and Escape to close. Search shows at most the first 20 matches per content type, with a refinement hint when more exist. Loading, empty, and retry states remain explicit. The sidebar Sign out action gains a warm fill and orange text on pointer hover or press; there is no duplicated owner context in the top bar. Rows show complete titles, slugs, managed-image thumbnails (or a document fallback), configured text-list tags, publication state, publication date, and updated date. Missing metadata stays truthful. Pagination remains server-backed. Narrow content containers stack row metadata instead of causing horizontal page overflow.

Editors retain the sidebar and use the owner-approved Ghost-inspired writing-first composition in charcoal and orange. A sticky header holds Back, textual save/publication state, Save draft, and orange Publish. A large, borderless multiline title leads a spacious Markdown canvas; a narrow, darker Entry settings inspector holds the slug and other configured fields. Omitted metadata appears as compact Add rows, not disabled forms. Add and Omit preserve local values until saving; omitted values are never serialized. Markdown is writable immediately and becomes included when typed into, explicitly added, or used for image insertion. Omission remains available. Real safe preview and the managed-image picker are the only Markdown tools. Unpublish and confirmed deletion are separated in the inspector for saved entries. No-autosave guidance and conflict recovery remain available. Preview Markdown opens a live, bounded side-by-side source/preview workspace; narrow Markdown containers switch between Write and Preview without losing input. The sticky header’s Versions action opens a non-modal saved-draft/published comparison, preserving the mounted editor. Snapshots use readable configured fields, safe Markdown, visibility labels, timestamps, and textual changed-field markers; JSON is secondary disclosure. Unsaved input is excluded and called out separately. Latest-server loading never replaces editor input without confirmation; stale-revision conflicts reveal this recovery workspace. These are current snapshots, not revision history. Narrow layouts stack the writing surface before settings and the snapshot comparison columns.

Image insertion uses a dedicated Bits UI Dialog, not the full image-management screen below the editor. Library and Upload views lead to a single selected image, an uncropped preview, metadata, entry-specific alt text or an explicit decorative choice, and one confirmation action. The footer stays visible while the library and details scroll. Narrow dialogs use a full-screen choose/review sequence with Back to library. Upload success selects the asset for review; cancellation leaves uploaded assets in the library but never alters entry fields. Markdown insertion uses the remembered selection end without deleting selected writing, returns the caret after insertion, and reveals Write mode when necessary. Escape/Cancel restores the invoking control; focus trapping and scroll locking come from Bits UI. Deletion remains on the standalone Images screen.

Images use the same palette, an outlined upload area, orange upload action, responsive thumbnail grid, and explicit delete controls. Sign-in uses the shared wordmark and compact charcoal panel.

## Interaction and accessibility

Use Lucide Svelte icons consistently; decorative icons are hidden from assistive technology. Preserve visible labels, complete titles, keyboard focus outlines, skip navigation, disabled semantics, textual errors, request states, and confirmation before discarding work. Hover styling applies only to fine pointers. No ornamental motion, glow, analytics, dead menus, or selection checkboxes without a corresponding action.

## Verification

Frontend component tests, Svelte checks, and production build are the engineering checks. Browser previews use synthetic HTTP fixtures, not real owner credentials or production content; they do not verify deployment or backend persistence.
