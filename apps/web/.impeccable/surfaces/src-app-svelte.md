---
version: 1
slug: "src-app-svelte"
primary_target: "src/App.svelte"
related_targets:
  [
    "src/app.css",
    "src/lib/Sidebar.svelte",
    "src/lib/Workspace.svelte",
    "src/lib/EntryList.svelte",
    "src/lib/EntryEditor.svelte",
    "src/lib/FieldEditor.svelte",
    "src/lib/ImageLibrary.svelte",
    "src/lib/ImagePicker.svelte",
    "src/lib/OwnerLogin.svelte",
  ]
---

# Admin workspace

Mode: Operate. The owner approved applying both supplied mockups across Posts, Projects, Images, and the editor. The editor mockup determines charcoal surfaces and orange actions; the list mockup determines sidebar, top search, title/action header, filtering, metadata rows, and pagination. These explicit references supersede the former Gallery Index sketch.

Preserve server-backed filtering and pagination, configured content definitions, title and slug rules, optional-field omission, managed-image privacy, safe Markdown preview, explicit save/publication, conflict recovery, and unsaved-change protection. Do not add mock content or inert tag/sort/selection/account-menu controls. Use actual entry metadata and Lucide Svelte icons. Narrow layouts wrap navigation and stack the editor and entry metadata.

## Entry editor · approved Ghost reference

The owner explicitly chose Ghost's editor and asked to keep charcoal/orange and existing navigation. This pins the surface composition; no concept tournament or replacement visual identity is needed. Reference: https://ghost.org/help/post-settings/ (official editor/settings screenshot).

Direction contract:

- SCOPE: Operate; Posts, Projects, and arbitrary configured entry forms. Preserve schema semantics, explicit saving, publication isolation, omission, and all recovery safeguards.
- WORLD: Existing charcoal/orange tokens, system sans, Lucide icons. No changes to list or navigation identity.
- FIRST VIEWPORT: Slim action header, a prominent borderless title over a spacious Markdown writing surface, and a quiet narrow settings inspector. No repeated disabled inputs or bottom action tray.
- VISITOR PATH: Write first; add metadata when needed; Save draft before Publish. Mobile stacks settings below the writing area.
- SIGNATURE INTERACTION: Type directly into an omitted Markdown field to include it; compact Add/Omit metadata controls preserve local values before saving. Newly added controls receive keyboard focus. Preview Markdown opens live side-by-side panes, with a Write/Preview switch in narrow containers. Header-level Versions opens readable, responsive saved/public comparisons with changed-field markers and a separate unsaved-input notice. Returning to writing preserves input and restores focus; conflict recovery retains explicit loading and confirmed replacement. Research rationale: `../../../../docs/EDITOR_PREVIEW_RESEARCH.md`.
- FINISH: Check empty and populated editors at desktop/intermediate/mobile sizes, long titles, optional-field omission, errors, image selection, preview, and guarded mutations. Engineering checks include component tests, Svelte checks, and build.

## Image selection · approved modal

Use the existing Bits UI Dialog primitive for a task-specific image picker. Library/Upload views, single thumbnail selection, a full image preview, and entry-owned alt text or an explicit decorative choice lead to one confirmation action. Do not include asset deletion or invent filename/search capabilities. On narrow dialogs, use a full-screen choose/review flow; keep Cancel and confirmation visible. Opening/cancelling does not change editor input or include omitted fields. Uploads are persisted separately and remain in the library if insertion is cancelled. Confirmed Markdown insertion preserves selected text, inserts at its remembered end, and returns the caret to Write mode. Keep session handling, query pagination, upload validation/retry, and keyboard focus safeguards. Rationale: `../../../../docs/IMAGE_PICKER_RESEARCH.md`.

Seed: none (owner-specified Ghost composition; established visual world).

Durable tokens and component rules: `DESIGN.md`. Browser verification uses synthetic API responses to inspect desktop and mobile composition without modifying owner data.
