# Image insertion: research and design options

Research date: 2026-10-28. Research informed the subsequently approved Bits UI modal implementation. The current-flow observations below describe the pre-redesign baseline.

## Current Zupka flow

Inspected `apps/web/src/lib/EntryEditor.svelte`, `FieldEditor.svelte`, `ImageLibrary.svelte`, and `packages/contracts/src/images.ts`.

- The insertion action mounts the full image-library screen below the editor and moves focus there. This changes the owner's location in the page rather than presenting a bounded selection task.
- Selection mode still includes permanent-delete controls, long asset IDs, upload controls, and pagination on the same surface.
- One alt-text input sits above the image grid, rather than alongside a specific selected image.
- Markdown insertion always appends to the end of the field; it does not use the caret position.
- Opening insertion enables an omitted Markdown field before an image is chosen. Cancelling should instead leave entry input unchanged.
- Current image DTOs include ID, media type, bytes, dimensions, creation date, active/deleting state, and URL. Original filenames and searchable titles are not provided. Image listing supports pagination, not text search. Active/deleting does not indicate public/private visibility.

## Primary-source findings

### WordPress: task-specific media window

The official **Classic Editor** guide describes placing the cursor first, opening Add Media, choosing Upload Files or Media Library, selecting a thumbnail, reviewing attachment details on the right, and confirming insertion. Selection and insertion are separate steps.

Source: https://wordpress.org/documentation/article/inserting-images-into-posts-and-pages/

Take: library/upload entry points, explicit selection, a preview/details area, and insertion at the intended writing position. Do not copy alignment, image-size controls, or asset-level metadata semantics: Zupka's consumers own rendering and alt text belongs to each entry use.

### Sanity: browse first, inspect the selection second

Sanity's Media Library has an asset list, library menu, and asset sidebar. Upload is available from the asset list, and details adapt to selection. This source describes its larger paid asset-management product, not proof that a specific Studio picker uses a modal.

Source: https://www.sanity.io/docs/media-library/interface

Take: visually led browsing and selection-specific details. Do not import folders, collections, bulk operations, or Sanity's visibility rules into Zupka.

### Ghost: keep image acquisition inside authoring

Ghost's official Unsplash integration documents selecting the image source from the editor, browsing/searching, and choosing an image for the post. This is external-image acquisition, not evidence of a reusable owned-image library.

Source: https://ghost.org/integrations/unsplash/

Take: a short, contextual insertion flow. Do not add external stock services or copy search when Zupka lacks searchable asset metadata.

### WAI-ARIA: a modal needs real interaction boundaries

The APG modal-dialog pattern requires an inert background, a contained tab sequence, an accessible dialog name, and actual modal behavior rather than just modal attributes.

Source: https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/

Take: use the project's existing Bits UI dialog primitive; preserve editor context and deliberately manage focus, dismissal, scrolling, and screen-reader labels. Specific implementation behavior still needs verification against that dependency's installed version.

## Options

### A. Focused image-picker modal — recommended

A wide charcoal dialog with a thumbnail grid on the left and a selected-image preview/details panel on the right. Compact header with `Insert image`, `Library` / `Upload`, and Close. Footer remains visible: Cancel and one orange `Insert image` action, disabled until a usable image is selected.

The details panel shows the full image without cropping, dimensions, media type/size, an entry-specific alt-text field, and a decorative-image choice. Display a concise selected state on the thumbnail. Avoid UUIDs and per-tile buttons as the visual hierarchy; IDs can remain secondary details if needed. No Delete control in this task; asset management stays on Images.

Use existing pagination and recent-first server ordering. Upload success selects the returned asset and keeps the dialog open for alt-text review. Empty state offers Upload image. Request failures stay inside the picker and support retry without losing entry input.

On phones, use a full-screen dialog: choose from the grid, then review the selected image/alt text with a visible Back to library action and persistent insert footer. This avoids squeezing the desktop details sidebar under a long grid.

Why: insertion is a discrete choose/review/confirm task that benefits from protected focus, not simultaneous editing. A dialog preserves the writing position and does not compete with the editor's existing settings and preview panes.

### B. Contextual side drawer

A right-side drawer retains more of the editor in view and can suit repeated image selection. However, it competes with Entry settings and the split preview, and becomes a full-screen sheet on narrow screens anyway. Prefer only if frequent multi-image insertion is a demonstrated main workflow.

### C. Lightweight inline inserter

A small panel near the writing location offers recent thumbnails and Upload, with a route to a full picker. Fast for a very small, recently used library, but adds two surfaces and more keyboard/positioning complexity. Not the first implementation.

## Behavior improvements that matter more than the container

1. Save the Markdown caret/selection before opening. Insert at that position (with appropriate Markdown line breaks), place the caret after insertion, and return focus to writing. For a selected text range, prefer preserving authored text rather than silently deleting it; the exact policy should be settled before implementation.
2. Opening or cancelling does not enable omitted fields, modify alt text, change content, or mark the entry dirty. Enable the field only when insertion is confirmed.
3. Keep alt text associated with the selected asset/use. Do not accidentally reuse a previous selection's description when switching images. Decorative means intentionally empty alt text; never generate descriptions from IDs.
4. Reuse the chooser for configured image fields, with action labels matching the context: Insert image, Choose image, or Replace image. Preserve existing field values until confirmation.
5. Escape/Cancel/Close returns to the invoking control without changing the entry. Confirmed Markdown insertion returns to the source, including switching the narrow editor from Preview to Write when needed. Preserve scroll and unsaved input.
6. Uploading persists an asset independently of entry insertion. Cancelling after upload leaves the new upload in the library; do not imply that Cancel rolls it back or silently delete it.
7. Do not label all active assets Private or Public: the current picker DTO does not expose reference-derived visibility. General copy can explain that new uploads are private until publication references them.

## Proposed first scope

Implement A with existing tokens, Lucide icons, Bits UI, image API, single selection, pagination, upload/retry, entry-specific alt text, and caret-aware Markdown insertion. Keep the standalone Images management page separate. Exclude search, filenames, folders, tags, multi-select, cropping, resizing, external providers, and backend changes.

Implemented default: Library, with an adjacent Upload view. Selected text is preserved: Markdown insertion uses the remembered selection end rather than replacing the range. The implementation uses the existing Bits UI Dialog dependency and keeps image management separate.

Verification: frontend component tests cover selection, cancellation/focus, alt-text isolation, decorative images, insertion position, upload review, oversize rejection, and library retry/pagination. Local Chromium fixtures exercise the focus trap, Escape, upload dismissal guards, narrow Preview-to-Write return, and five viewport widths. These synthetic checks do not claim production persistence or deployment verification.
