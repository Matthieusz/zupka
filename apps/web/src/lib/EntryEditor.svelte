<script lang="ts">
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { tick } from "svelte";
  import { Schema, Match } from "effect";
  import type { AdminEntry, ManagedImage } from "@zupka/contracts";
  import { suggestSlug, managedImageUrl, type ContentTypeDefinition } from "@zupka/shared";
  import { fieldInputs, parseControls } from "./editor-model.js";
  import {
    getEntry,
    writeEntry,
    EditorError,
    editorMessages,
    type EntryCommand,
  } from "./editing.js";
  import { runEffect } from "./effect.js";
  import FieldEditor from "./FieldEditor.svelte";
  import Sidebar from "./Sidebar.svelte";
  import {
    ArrowLeft,
    Save,
    ArrowUpRight,
    EyeOff,
    Trash2,
    Layers,
    X,
    FileText,
    Globe,
    RefreshCw,
  } from "lucide-svelte";
  import EntrySnapshot from "./EntrySnapshot.svelte";
  import ImagePicker from "./ImagePicker.svelte";

  let {
    type,
    initial,
    active,
    onClose,
    onSessionLost,
    onLogout,
  }: {
    type: ContentTypeDefinition;
    initial: typeof AdminEntry.Type | null;
    active: boolean;
    onClose: () => Promise<void>;
    onSessionLost: () => Promise<void>;
    onLogout: () => void;
  } = $props();

  // These are intentionally initialized once. Session refresh must never reset authored input.
  // svelte-ignore state_referenced_locally
  let saved = $state(initial);

  // svelte-ignore state_referenced_locally
  let title = $state(initial?.draft.title ?? "");

  // svelte-ignore state_referenced_locally
  let slug = $state(initial?.draft.slug ?? "");

  // svelte-ignore state_referenced_locally
  let inputs = $state(fieldInputs(type, initial));

  let slugEdited = $state(false);

  let errors = $state<Record<string, string>>({});

  let message = $state("");

  let announcement = $state("");

  let conflict = $state(false);

  let latest = $state<typeof AdminEntry.Type | null>(null);

  let picker = $state<string | null>(null);

  let pickerTrigger: HTMLButtonElement | null = null;

  let insertionPoint = 0;

  let revealSource: (() => void) | null = null;

  const pickerField = $derived(type.fields.find((field) => field.id === picker));

  let loadingLatest = $state(false);

  let versionsOpen = $state(false);

  let baseline = $state("");

  const fingerprint = $derived(JSON.stringify({ title, slug, inputs }));

  // svelte-ignore state_referenced_locally
  baseline = JSON.stringify({ title, slug, inputs });

  const dirty = $derived(fingerprint !== baseline);

  const cache = useQueryClient();

  const originalHash = globalThis.location.hash;

  $effect(() => {
    if (active) document.getElementById("editor-heading")?.focus();
  });

  const changedFields = $derived(
    saved?.published
      ? [
          ...(saved.draft.title !== saved.published.content.title ? ["title"] : []),
          ...(saved.draft.slug !== saved.published.content.slug ? ["slug"] : []),
          ...type.fields.flatMap((field) =>
            JSON.stringify(saved?.draft.fields[field.id]) !==
            JSON.stringify(saved?.published?.content.fields[field.id])
              ? [field.id]
              : [],
          ),
        ]
      : [],
  );

  function adopt(entry: typeof AdminEntry.Type) {
    saved = entry;
    title = entry.draft.title;
    slug = entry.draft.slug;
    inputs = fieldInputs(type, entry);
    baseline = JSON.stringify({ title, slug, inputs });
    errors = {};
    latest = null;
    conflict = false;
    versionsOpen = false;
  }

  async function focusFeedback() {
    await tick();
    document.getElementById("editor-feedback")?.focus();
  }

  const mutation = createMutation(() => ({
    mutationFn: async (
      action: "save" | "publish" | "unpublish" | "delete",
    ): Promise<{
      entry: typeof AdminEntry.Type | null | undefined;
      errors: Record<string, string>;
    }> => {
      const parsed = parseControls(
        type,
        title,
        slug,
        inputs,
        action === "publish" ? "publish" : "draft",
      );

      if (!parsed.content) return Promise.resolve({ entry: undefined, errors: parsed.errors });

      const command: EntryCommand = !saved
        ? { kind: "create", typeId: type.id, content: parsed.content }
        : action === "save"
          ? { kind: "save", entry: saved, content: parsed.content }
          : { kind: action, entry: saved };

      return runEffect(writeEntry(command)).then((entry) => ({
        entry,
        errors: {},
      }));
    },
    retry: false,
    gcTime: 0,
    onMutate: () => {
      announcement = "";
    },
    onSuccess: async (result, action) => {
      errors = result.errors;

      if (result.entry === undefined) {
        message = "Check the highlighted fields. Your input has not been saved.";
        await focusFeedback();

        return;
      }

      if (result.entry === null) {
        await cache.invalidateQueries({ queryKey: ["admin", "entries"] });
        await onClose();

        return;
      }

      adopt(result.entry);
      message = "";
      announcement = Match.value(action).pipe(
        Match.when("save", () => "Draft saved. Saving does not publish."),
        Match.when("publish", () => "Published. The saved draft is now public."),
        Match.orElse(() => "Unpublished. The working draft is retained."),
      );
      await cache.invalidateQueries({ queryKey: ["admin", "entries"] });
      await cache.invalidateQueries({ queryKey: ["admin", "images"] });
    },
    onError: async (error) => {
      message = Schema.is(EditorError)(error)
        ? editorMessages[error.reason]
        : editorMessages.unavailable;
      conflict = Schema.is(EditorError)(error) && error.reason === "stale-revision";

      if (conflict) versionsOpen = true;

      if (Schema.is(EditorError)(error) && error.reason === "session-expired")
        await onSessionLost();
      await focusFeedback();
    },
  }));

  function handleShortcut(event: KeyboardEvent) {
    if (
      !active ||
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      !(event.ctrlKey || event.metaKey)
    )
      return;

    const target = event.target;
    const editor = document.getElementById("main-content");

    if (
      !(target instanceof Element) ||
      !editor?.contains(target) ||
      target.closest('[role="dialog"]')
    )
      return;

    const key = event.key.toLowerCase();

    const action =
      !event.shiftKey && key === "s"
        ? "save"
        : !event.shiftKey && key === "enter"
          ? "publish"
          : event.shiftKey && key === "p"
            ? "preview"
            : event.shiftKey && key === "i"
              ? "image"
              : null;

    if (!action) return;

    const markdownAction = action === "preview" || action === "image";

    const scope = markdownAction
      ? (target.closest("[data-markdown-field]") ?? editor.querySelector("[data-markdown-field]"))
      : editor;

    if (markdownAction && versionsOpen) return;
    const button = scope?.querySelector<HTMLButtonElement>(`[data-editor-shortcut="${action}"]`);

    if (!button) return;

    event.preventDefault();

    if (event.repeat || mutation.isPending || loadingLatest || button.matches(":disabled")) return;
    button.click();
  }

  async function showVersions(open: boolean) {
    versionsOpen = open;
    await tick();
    document.getElementById(open ? "versions-heading" : "versions-toggle")?.focus();
  }

  async function loadLatest() {
    if (!saved) return;
    loadingLatest = true;

    try {
      latest = await runEffect(getEntry(saved));
      message = "Latest saved version loaded. Your local input is unchanged.";
    } catch (error) {
      message = Schema.is(EditorError)(error)
        ? editorMessages[error.reason]
        : editorMessages.unavailable;

      if (Schema.is(EditorError)(error) && error.reason === "session-expired")
        await onSessionLost();
    } finally {
      loadingLatest = false;
    }
  }

  async function leave() {
    if (mutation.isPending || loadingLatest) return;

    if (!dirty || confirm("Discard unsaved changes and return to the entry list?")) await onClose();
  }

  async function cancelImageSelection() {
    picker = null;
    await tick();
    pickerTrigger?.focus({ preventScroll: true });
  }

  async function selectImage(image: typeof ManagedImage.Type, alt: string) {
    const field = type.fields.find((field) => field.id === picker);

    if (!field) return;
    const input = inputs[field.id];

    if (!input) return;

    if (field.kind === "markdown") {
      const safeAlt = alt.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]/g, " ");
      const insertion = `\n![${safeAlt}](${managedImageUrl(image.id)})\n`;
      input.text =
        input.text.slice(0, insertionPoint) + insertion + input.text.slice(insertionPoint);
      insertionPoint += insertion.length;
      revealSource?.();
    } else {
      input.text = image.id;
      input.alt = alt;
    }

    input.enabled = true;
    picker = null;
    await tick();
    const control = document.getElementById(`field-${field.id}`);
    control?.focus({ preventScroll: true });

    if (control instanceof HTMLTextAreaElement)
      control.setSelectionRange(insertionPoint, insertionPoint);
  }
</script>

<svelte:window
  onkeydown={handleShortcut}
  onhashchange={async () => {
    if (location.hash === "#main-content") return;
    if (
      mutation.isPending ||
      loadingLatest ||
      (dirty && !confirm("Discard unsaved changes and leave this editor?"))
    )
      history.replaceState(null, "", originalHash || location.pathname);
    else await onClose();
  }}
  onbeforeunload={(event) => {
    if (dirty || mutation.isPending) {
      event.preventDefault();
      event.returnValue = "";
    }
  }}
/>
<div class="editor-workspace">
  {#if active}<Sidebar
      selected={type.id}
      {onSessionLost}
      onLogout={() => {
        if (
          !mutation.isPending &&
          (!dirty ||
            confirm(
              "Sign out? Your unsaved input will remain in this tab until you close or discard the editor.",
            ))
        )
          onLogout();
      }}
    />{/if}
  <main id="main-content" class="editor" tabindex="-1">
    <header class="editor-header">
      <div class="navigation-state">
        <button class="back" onclick={leave} disabled={mutation.isPending || loadingLatest}
          ><ArrowLeft aria-hidden="true" />Back to {type.label}</button
        >
        <p class="state" data-state={dirty ? "changed" : saved?.state}>
          {saved
            ? saved.state === "published-with-draft-changes"
              ? "Published with draft changes"
              : saved.state === "published"
                ? "Published"
                : "Unpublished"
            : "Not saved"}{dirty ? " · Unsaved changes" : ""}
        </p>
        {#if mutation.isPending}<p class="state" role="status">Working…</p>{/if}
      </div>
      <fieldset class="header-actions" disabled={!active || mutation.isPending || loadingLatest}>
        {#if saved}<button
            id="versions-toggle"
            type="button"
            aria-expanded={versionsOpen}
            aria-controls="entry-versions"
            onclick={() => showVersions(!versionsOpen)}
            ><Layers aria-hidden="true" />Versions{#if changedFields.length}<span
                class="change-count">{changedFields.length}</span
              >{/if}</button
          >{/if}
        <button
          form="entry-form"
          type="submit"
          disabled={conflict}
          data-editor-shortcut="save"
          aria-keyshortcuts="Control+s Meta+s"
          title="Save draft (Ctrl/Cmd+S)"><Save aria-hidden="true" />Save draft</button
        >
        <button
          class="primary"
          type="button"
          disabled={!saved || dirty || conflict}
          data-editor-shortcut="publish"
          aria-keyshortcuts="Control+Enter Meta+Enter"
          title="Publish saved draft (Ctrl/Cmd+Enter)"
          onclick={() => {
            versionsOpen = false;
            mutation.mutate("publish");
          }}>Publish<ArrowUpRight aria-hidden="true" /></button
        >
      </fieldset>
    </header>
    <h1 class="sr-only" id="editor-heading" tabindex="-1">
      {saved ? "Edit entry" : `New entry · ${type.label}`}
    </h1>
    <p id="editor-announcement" class="sr-only" role="status" aria-atomic="true">{announcement}</p>
    {#if message}<p
        id="editor-feedback"
        role={mutation.isError || Object.keys(errors).length > 0 ? "alert" : "status"}
        tabindex="-1"
      >
        {message}
      </p>{/if}
    {#if saved}
      <section
        id="entry-versions"
        class="snapshots"
        hidden={!versionsOpen}
        aria-labelledby="versions-heading"
      >
        <div class="versions-heading">
          <div>
            <h2 id="versions-heading" tabindex="-1">Saved draft and published version</h2>
            <p>
              Compare your saved content with what is public. Unsaved editor input is not shown.
            </p>
          </div>
          <button type="button" aria-label="Close versions" onclick={() => showVersions(false)}
            ><X aria-hidden="true" /></button
          >
        </div>
        <p class="comparison-state" data-changed={changedFields.length > 0}>
          {saved.published
            ? changedFields.length
              ? `${changedFields.length} ${changedFields.length === 1 ? "field differs" : "fields differ"} from the published version.`
              : "The saved draft matches the published version."
            : "Only you can see this draft. It is not currently public."}
          {#if dirty}<span>You also have unsaved changes in the editor.</span>{/if}
        </p>
        <div class="version-columns">
          <article class="version-column" aria-label="Saved draft snapshot">
            <header class="version-header">
              <div class="version-name">
                <FileText aria-hidden="true" />
                <h3>Saved draft</h3>
                <span>Private</span>
              </div>
              <p>
                Revision {saved.revision} · Updated
                <time datetime={saved.updatedAt}
                  >{new Date(saved.updatedAt).toLocaleString("en", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}</time
                >
              </p>
            </header>
            <EntrySnapshot content={saved.draft} {type} changed={changedFields} />
          </article>
          <article class="version-column published-version" aria-label="Published version snapshot">
            <header class="version-header">
              <div class="version-name">
                <Globe aria-hidden="true" />
                <h3>Published version</h3>
                {#if saved.published}<span>Public</span>{/if}
              </div>
              <p>
                {#if saved.published}<time datetime={saved.published.publishedAt}
                    >{new Date(saved.published.publishedAt).toLocaleString("en", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}</time
                  >{:else}Not public{/if}
              </p>
            </header>
            {#if saved.published}<EntrySnapshot
                content={saved.published.content}
                {type}
                changed={changedFields}
              />
            {:else}<div class="unpublished-note">
                <Globe aria-hidden="true" />
                <h3>No current published version</h3>
                <p>
                  When you publish, the saved draft will appear here. Saving a draft never changes
                  what is public.
                </p>
              </div>{/if}
          </article>
        </div>
        <div class="version-recovery">
          <div>
            <h3>Latest saved version</h3>
            <p>
              Reload the server snapshot without replacing your editor input. These are current
              snapshots, not a revision history.
            </p>
          </div>
          <button disabled={!active || mutation.isPending || loadingLatest} onclick={loadLatest}
            ><RefreshCw aria-hidden="true" />{loadingLatest
              ? "Loading…"
              : "Load latest saved version"}</button
          >
        </div>
        {#if latest}
          <section class="latest-version">
            <h3>Latest saved version · revision {latest.revision}</h3>
            <EntrySnapshot content={latest.draft} {type} />
            <p>
              Copy any local work you want to keep before replacing the editor. There is no
              automatic merge.
            </p>
            <button
              disabled={!active || mutation.isPending || loadingLatest}
              onclick={() => {
                if (confirm("Discard local input and replace it with the latest saved version?")) {
                  if (latest) adopt(latest);
                  message = "Editor replaced with the latest saved draft.";
                }
              }}>Discard local input and use latest</button
            >
          </section>
        {/if}
      </section>
    {/if}
    <form
      hidden={versionsOpen}
      id="entry-form"
      novalidate
      onsubmit={(event) => {
        event.preventDefault();
        if (!active || mutation.isPending || loadingLatest || conflict) return;
        if (!saved && !slugEdited && slug === "" && title.trim()) slug = suggestSlug(title);
        versionsOpen = false;
        mutation.mutate("save");
      }}
    >
      <fieldset class="controls" disabled={!active || mutation.isPending || loadingLatest}>
        <div class="content-panel">
          <label class="entry-title">
            <span class="sr-only">Title</span><textarea
              rows="1"
              placeholder="Entry title"
              value={title}
              oninput={(event) => {
                title = event.currentTarget.value;
              }}
              onblur={() => {
                if (!saved && !slugEdited && slug === "" && title.trim()) slug = suggestSlug(title);
              }}
              aria-invalid={Boolean(errors.title)}
              aria-describedby={errors.title ? "error-title" : undefined}></textarea></label
          >
          {#if errors.title}<p id="error-title" role="alert">{errors.title}</p>{/if}
          {#each type.fields.filter((field) => field.kind === "markdown") as field (field.id)}
            {@render customField(field)}
          {/each}
          <p class="save-note">
            Changes are not saved automatically. Save your draft before publishing.
          </p>
        </div>
        <aside class="metadata" aria-label="Entry settings">
          <h2>Entry settings</h2>
          <div class="slug-field">
            <label
              >Slug<input
                placeholder="enter-url-slug"
                bind:value={slug}
                oninput={() => {
                  slugEdited = true;
                }}
                readonly={saved?.firstPublishedAt !== null && saved !== null}
                aria-invalid={Boolean(errors.slug)}
                aria-describedby={errors.slug ? "slug-help error-slug" : "slug-help"}
              /></label
            >
            <p id="slug-help">
              {saved?.firstPublishedAt
                ? "Locked after first publication, including after unpublishing."
                : "Unique within this content type. Editable until first publication."}
            </p>
            {#if errors.slug}<p id="error-slug" role="alert">{errors.slug}</p>{/if}
          </div>
          {#each type.fields.filter((field) => field.kind !== "markdown") as field (field.id)}
            {@render customField(field)}
          {/each}
          {#if saved}
            <div class="entry-management">
              <h3>Manage entry</h3>
              <button
                type="button"
                disabled={!saved?.published || dirty || conflict}
                onclick={() => mutation.mutate("unpublish")}
                ><EyeOff aria-hidden="true" />Unpublish</button
              >
              <button
                type="button"
                disabled={!saved || saved.published !== null || dirty || conflict}
                onclick={() => {
                  if (confirm("Permanently delete this entry? This cannot be undone."))
                    mutation.mutate("delete");
                }}><Trash2 aria-hidden="true" />Delete entry</button
              >
            </div>
          {/if}
        </aside>
      </fieldset>
    </form>
    <ImagePicker
      open={active && picker !== null}
      action={pickerField?.kind === "markdown"
        ? "Insert image"
        : picker && inputs[picker]?.text
          ? "Replace image"
          : "Choose image"}
      fieldLabel={pickerField?.label ?? "entry"}
      onCancel={cancelImageSelection}
      onSelect={selectImage}
      {onSessionLost}
    />
  </main>
</div>

{#snippet customField(field: ContentTypeDefinition["fields"][number])}
  {@const input = inputs[field.id]}
  {#if input}<FieldEditor
      {field}
      bind:input={
        () => input,
        (value) => {
          inputs[field.id] = value;
        }
      }
      error={errors[field.id]}
      creationDefault={saved === null && field.default !== undefined}
      chooseImage={(trigger, showSource) => {
        pickerTrigger = trigger;
        revealSource = showSource;
        const control = document.getElementById(`field-${field.id}`);
        insertionPoint =
          input.enabled && control instanceof HTMLTextAreaElement
            ? control.selectionEnd
            : input.text.length;
        picker = field.id;
      }}
    />{/if}
{/snippet}

<style>
  .editor-workspace {
    display: grid;
    grid-template-columns: 12.5rem minmax(0, 1fr);
    min-block-size: 100svh;
  }
  .editor {
    container-type: inline-size;
  }
  .editor-header {
    position: sticky;
    inset-block-start: 0;
    z-index: 2;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem 1.5rem;
    padding: 1rem;
    border-block-end: 1px solid var(--rule);
    background: var(--background);
  }
  .navigation-state,
  .header-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
  }
  .header-actions {
    border: 0;
    padding: 0;
    margin: 0;
  }
  .back {
    padding-inline: 0;
    border-color: transparent;
    background: transparent;
  }
  .state {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .state::before {
    content: "";
    inline-size: 0.375rem;
    block-size: 0.375rem;
    border-radius: 50%;
    background: currentColor;
    flex: none;
  }
  .state[data-state="published"] {
    color: var(--success);
  }
  .state[data-state="changed"],
  .state[data-state="published-with-draft-changes"] {
    color: var(--changed);
  }
  .controls {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 19rem;
    border: 0;
    margin: 0;
    padding: 0;
    min-block-size: calc(100svh - 5rem);
  }
  .content-panel {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 1.5rem;
    padding-block: clamp(2rem, 5cqi, 5rem) 2rem;
    padding-inline: clamp(1.25rem, 5cqi, 5rem);
    max-inline-size: 62rem;
    inline-size: 100%;
    justify-self: center;
  }
  .entry-title textarea {
    inline-size: 100%;
    background: transparent;
    border: 0;
    border-radius: 0;
    padding: 0;
    font-family: inherit;
    font-size: clamp(2rem, 3.5cqi, 3.25rem);
    line-height: 1.16;
    font-weight: 650;
    letter-spacing: -0.035em;
    min-block-size: 1.2lh;
    max-block-size: none;
    resize: none;
  }
  .entry-title textarea::placeholder {
    color: var(--muted);
  }
  .save-note {
    margin-block-start: auto;
    padding-block-start: 2rem;
    font-size: 0.75rem;
  }
  .metadata {
    background: var(--rail);
    border-inline-start: 1px solid var(--rule);
    padding: 1.75rem 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  h2 {
    font-size: 0.9375rem;
    font-weight: 600;
  }
  .slug-field {
    display: grid;
    gap: 0.5rem;
  }
  label {
    display: grid;
    gap: 0.625rem;
    font-size: 0.8125rem;
    font-weight: 500;
  }
  #slug-help {
    font-size: 0.75rem;
    line-height: 1.6;
  }
  .entry-management {
    display: grid;
    gap: 0.75rem;
    margin-block-start: auto;
    padding-block-start: 1.5rem;
    border-block-start: 1px solid var(--rule);
  }
  .entry-management h3 {
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--muted);
  }
  .entry-management button {
    justify-content: start;
    background: transparent;
    border-color: var(--rule);
  }
  .entry-management button:last-child {
    color: var(--danger);
  }
  p {
    color: var(--muted);
  }
  [role="alert"] {
    color: var(--danger);
  }
  #editor-feedback {
    padding: 1rem clamp(1rem, 3cqi, 2.5rem);
    border-block-end: 1px solid var(--rule);
  }
  .snapshots[hidden] {
    display: none;
  }
  .snapshots {
    display: grid;
    gap: 0.875rem;
    border-block-start: 1px solid var(--rule);
    padding: 1.5rem clamp(1rem, 3cqi, 2.5rem);
  }
  .snapshots p {
    max-inline-size: 75ch;
  }
  .snapshots {
    gap: 1.5rem;
    border-block-start: 0;
    padding-block: 2rem;
  }
  .versions-heading,
  .version-recovery {
    display: flex;
    flex-wrap: wrap;
    align-items: start;
    justify-content: space-between;
    gap: 1rem;
  }
  .versions-heading > div,
  .version-recovery > div {
    flex: 1 1 18rem;
  }
  .versions-heading h2 {
    font-size: 1.375rem;
    margin-block-end: 0.5rem;
  }
  .versions-heading > button {
    background: transparent;
    border-color: var(--rule);
    min-block-size: 2.75rem;
    min-inline-size: 2.75rem;
  }
  .snapshots p {
    font-size: 0.8125rem;
    line-height: 1.6;
  }
  .snapshots .comparison-state {
    padding: 0.875rem 1rem;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    max-inline-size: none;
  }
  .comparison-state[data-changed="true"] {
    color: var(--changed);
  }
  .comparison-state span {
    display: block;
    color: var(--muted);
  }
  .change-count {
    color: var(--changed);
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
  }
  .version-columns {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 23rem), 1fr));
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    overflow: clip;
  }
  .version-column {
    padding: clamp(1rem, 2.5cqi, 2rem);
  }
  .version-column + .version-column {
    border-inline-start: 1px solid var(--rule);
    border-block-start: 1px solid var(--rule);
    background: var(--rail);
  }
  .version-header {
    display: grid;
    gap: 0.625rem;
    margin-block-end: 1.75rem;
    padding-block-end: 1.25rem;
    border-block-end: 1px solid var(--rule);
  }
  .version-name {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .version-name :global(svg) {
    inline-size: 1.125rem;
    block-size: 1.125rem;
    color: var(--muted);
  }
  .snapshots h3 {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
  }
  .version-name span {
    margin-inline-start: auto;
    color: var(--muted);
    font-size: 0.6875rem;
  }
  .published-version .version-name span {
    color: var(--success);
  }
  .unpublished-note {
    display: grid;
    justify-items: start;
    gap: 0.75rem;
    padding-block: 1rem 2rem;
  }
  .unpublished-note :global(svg) {
    color: var(--muted);
    inline-size: 1.5rem;
    block-size: 1.5rem;
  }
  .version-recovery {
    border-block-start: 1px solid var(--rule);
    padding-block-start: 1.5rem;
    align-items: center;
  }
  .version-recovery h3 {
    margin-block-end: 0.375rem;
  }
  .latest-version {
    display: grid;
    gap: 1.25rem;
    border: 1px solid var(--rule-strong);
    border-radius: var(--radius);
    padding: 1.5rem;
  }
  .latest-version > button {
    justify-self: start;
  }
  .content-panel:has(:global(.markdown-panes.split)) {
    max-inline-size: none;
    padding-inline: clamp(1.25rem, 3cqi, 2.5rem);
  }
  @media (width < 48rem) {
    .editor-workspace {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  @media (width >= 48rem) {
    .editor {
      display: flex;
      flex-direction: column;
      block-size: 100dvh;
    }
    .editor-header,
    #editor-feedback {
      flex: none;
    }
    #entry-form,
    .snapshots {
      flex: 1;
      min-block-size: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
    }
  }
  @container (width >= 50rem) {
    .controls {
      block-size: 100%;
      min-block-size: 0;
    }
    .content-panel,
    .metadata {
      min-block-size: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
    }
  }
  @container (width < 32rem) {
    .header-actions {
      inline-size: 100%;
      gap: 0.5rem;
    }
    .header-actions button {
      flex: 1;
      min-block-size: 2.75rem;
      padding-inline: 0.5rem;
      gap: 0.375rem;
      font-size: 0.8125rem;
    }
  }
  @container (width < 50rem) {
    .controls {
      grid-template-columns: minmax(0, 1fr);
      min-block-size: auto;
    }
    .metadata {
      border-inline-start: 0;
      border-block-start: 1px solid var(--rule);
    }
    .content-panel {
      min-block-size: 60svh;
    }
  }
</style>
