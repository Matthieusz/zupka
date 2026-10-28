# Editor preview and snapshot comparison

Research: 2026-10-28. Scope: Zupka admin editor; preserve charcoal/orange, explicit saving, independent draft/public content, and conflict safeguards.

## Primary-source patterns

- **Visual Studio Code:** Markdown preview can open beside the source and updates while typing. It also supports source/preview switching and synchronized scrolling. [Official Markdown guide](https://code.visualstudio.com/docs/languages/markdown#_markdown-preview).
- **Sanity Studio:** a perspective switcher near the top of the editor separates draft and published views; published content is ordinarily read-only. The goal is to inspect what is actually live without draft edits obscuring it. [Official perspective-switching release notes](https://www.sanity.io/docs/changelog/9bfb4c69-460f-42b9-964a-a39c0a10f29b).
- **Sanity Studio:** document history is an explicitly accessed inspection experience, with retained revisions backed by stored transactions. It is not merely another name for a current draft/public pair. [Official history guide](https://www.sanity.io/docs/user-guides/history-experience).

## Applied to Zupka

1. The existing Preview Markdown action opens live source and rendered content beside each other. Both panes have bounded, independently scrollable heights so a long source does not push the preview below it. Narrow containers use Write/Preview controls in the same space, preserving text when switching. Scroll synchronization is not implemented; source/rendered structures do not have a line mapping.
2. A Versions control in the sticky editor header opens a non-modal comparison workspace. Returning to writing preserves the mounted form and unsaved input. There is no extra dialog or bottom-of-page hunt.
3. Saved draft and Published version appear side by side when space allows, stacked otherwise. Each has explicit visibility, human-readable timestamps, readable field values, safe Markdown rendering, and changed-field labels. JSON is secondary disclosure, not the default presentation.
4. Comparisons use saved snapshots only, never unsaved input. The UI explains this and flags unsaved editor changes separately. An unpublished entry has an explicit empty published state, including entries that were previously published.
5. Latest-server loading and confirmed editor replacement remain distinct. A stale-revision conflict reveals the comparison workspace, retains local input, and keeps mutation blocked until explicitly resolved.
6. These are **current snapshots**, not historical revisions. No autosave, historical restore, backend migration, or new persistence was added. Preview remains an approximation: consuming sites own final styling.

## Verification boundary

Component tests cover live rendering, saved/public separation, configured field values, omission, and conflict recovery. Local Chromium checks use synthetic API responses at desktop, intermediate, mobile, and 200%-equivalent layout widths; they do not verify production persistence or HTTPS deployment.
