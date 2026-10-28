<script lang="ts">
  import { tick } from "svelte";
  import type { FieldDefinition } from "@zupka/shared";
  import type { FieldInput } from "./editor-model.js";
  import MarkdownPreview from "./MarkdownPreview.svelte";
  import { Plus, X, Eye, ImagePlus, Code } from "lucide-svelte";

  let {
    field,
    input = $bindable(),
    error,
    chooseImage,
    creationDefault,
  }: {
    field: FieldDefinition;
    input: FieldInput;
    error: string | undefined;
    chooseImage: (trigger: HTMLButtonElement, showSource: () => void) => void;
    creationDefault: boolean;
  } = $props();

  let preview = $state(false);

  let mobilePreview = $state(false);
</script>

<fieldset
  class:markdown={field.kind === "markdown"}
  class:omitted={!input.enabled}
  data-markdown-field={field.kind === "markdown" ? field.id : undefined}
>
  <legend class="sr-only">{field.label}</legend>
  <div class="field-heading">
    <span class="field-label"
      >{field.label}{#if field.required}<small>Required to publish</small>{/if}</span
    >
    {#if !input.enabled}
      <button
        id={`add-field-${field.id}`}
        class="add-field"
        type="button"
        aria-label={`Add ${field.label}`}
        aria-describedby={error ? `error-${field.id}` : undefined}
        onclick={async () => {
          input.enabled = true;
          await tick();
          document.getElementById(`field-${field.id}`)?.focus();
        }}><Plus aria-hidden="true" />Add</button
      >
    {:else if input.enabled && !creationDefault}
      <button
        class="omit-field"
        type="button"
        aria-label={`Omit ${field.label}`}
        onclick={async () => {
          input.enabled = false;
          preview = false;
          await tick();
          document.getElementById(`add-field-${field.id}`)?.focus();
        }}><X aria-hidden="true" /></button
      >
    {:else}
      <span class="field-hint">{field.required ? "Required to publish" : "Optional"}</span>
    {/if}
  </div>
  {#if creationDefault}<p class="field-hint">
      This default is applied on first save. You can omit the field after saving.
    </p>{/if}
  {#if input.enabled || field.kind === "markdown"}
    <div class="field-value">
      {#if field.kind !== "text-list" && field.kind !== "image"}<label
          class="sr-only"
          for={`field-${field.id}`}>{field.label}</label
        >{/if}
      {#if field.kind === "text-list"}
        {#each input.items as item, index}
          <div class="list-item">
            <label>
              <span class="sr-only">{field.label} item {index + 1}</span>
              <textarea rows="1" bind:value={input.items[index]}></textarea>
            </label>
            <button
              class="omit-field"
              type="button"
              aria-label={`Remove ${field.label} item ${index + 1}`}
              onclick={() => {
                input.items.splice(index, 1);
              }}><X aria-hidden="true" /></button
            >
          </div>
        {/each}
        <button
          id={`field-${field.id}`}
          class="add-item"
          type="button"
          onclick={() => {
            input.items.push("");
          }}><Plus aria-hidden="true" />Add {field.label} item</button
        >
        {#if input.items.length}<p class="field-hint">
            Empty items and line breaks within items are preserved.
          </p>{/if}
      {:else if field.kind === "markdown"}
        <div class="markdown-toolbar">
          <span><Code aria-hidden="true" />Markdown</span>
          <button
            type="button"
            aria-pressed={preview}
            disabled={!input.enabled}
            data-editor-shortcut="preview"
            aria-keyshortcuts="Control+Shift+p Meta+Shift+p"
            title="Toggle Markdown preview (Ctrl/Cmd+Shift+P)"
            onclick={() => {
              preview = !preview;
              mobilePreview = preview;
            }}><Eye aria-hidden="true" />{preview ? "Hide preview" : "Preview Markdown"}</button
          >
          <button
            type="button"
            data-editor-shortcut="image"
            aria-keyshortcuts="Control+Shift+i Meta+Shift+i"
            title="Insert managed image (Ctrl/Cmd+Shift+I)"
            onclick={(event) => {
              chooseImage(event.currentTarget, () => {
                mobilePreview = false;
              });
            }}><ImagePlus aria-hidden="true" />Insert managed image</button
          >
        </div>
        {#if preview}
          <div class="compact-views" role="group" aria-label={`${field.label} view`}>
            <button
              type="button"
              aria-pressed={!mobilePreview}
              onclick={() => {
                mobilePreview = false;
              }}><Code aria-hidden="true" />Write</button
            >
            <button
              type="button"
              aria-pressed={mobilePreview}
              onclick={() => {
                mobilePreview = true;
              }}><Eye aria-hidden="true" />Preview</button
            >
          </div>
        {/if}
        <div class="markdown-panes" class:split={preview} class:show-preview={mobilePreview}>
          <textarea
            placeholder="Start writing in Markdown…"
            id={`field-${field.id}`}
            value={input.enabled ? input.text : ""}
            oninput={(event) => {
              input.text = event.currentTarget.value;
              input.enabled = true;
            }}
            aria-invalid={Boolean(error)}
            aria-describedby={error
              ? `error-${field.id}`
              : !input.enabled
                ? `omitted-${field.id}`
                : undefined}
            rows="14"></textarea>
          {#if preview}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex (The scrollable preview needs keyboard scrolling.) -->
            <section class="preview-panel" aria-label={`${field.label} preview`} tabindex="0">
              <p class="preview-label"><Eye aria-hidden="true" />Live preview</p>
              {#if input.text}
                <MarkdownPreview source={input.text} />
              {:else}<p class="field-hint">
                  Your Markdown preview will appear here as you write.
                </p>{/if}
            </section>
          {/if}
        </div>
        {#if !input.enabled}<p id={`omitted-${field.id}`} class="field-hint">
            Not included in this draft. Start typing to add {field.label.toLowerCase()}.
          </p>{/if}
        {#if preview}<p class="field-hint">
            Raw HTML is shown as text. Only managed images load in this preview. Your site controls
            the final styling.
          </p>{/if}
      {:else if field.kind === "text"}
        <textarea
          id={`field-${field.id}`}
          rows="3"
          bind:value={input.text}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `error-${field.id}` : undefined}></textarea>
      {:else if field.kind === "select"}
        <select
          id={`field-${field.id}`}
          bind:value={input.text}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `error-${field.id}` : undefined}
          ><option value="">Choose…</option>{#each field.choices as choice}<option value={choice}
              >{choice}</option
            >{/each}</select
        >
      {:else if field.kind === "boolean"}
        <select
          id={`field-${field.id}`}
          bind:value={input.text}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `error-${field.id}` : undefined}
          ><option value="false">False</option><option value="true">True</option></select
        >
      {:else if field.kind === "image"}
        {#if input.text}<img
            src={`/api/images/${encodeURIComponent(input.text)}`}
            alt={input.alt}
          />{/if}
        <button
          id={`field-${field.id}`}
          class="image-picker"
          type="button"
          aria-describedby={error ? `error-${field.id}` : undefined}
          onclick={(event) => chooseImage(event.currentTarget, () => {})}
          ><ImagePlus aria-hidden="true" />{input.text
            ? "Replace image"
            : `Choose ${field.label}`}</button
        >
        <label>Alt text<input bind:value={input.alt} /></label>
      {:else}
        <input
          id={`field-${field.id}`}
          type={field.kind === "url" ? "url" : "text"}
          inputmode={field.kind === "number" ? "decimal" : undefined}
          bind:value={input.text}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `error-${field.id}` : undefined}
        />
        {#if field.kind === "datetime"}<p class="field-hint">
            ISO date/time with timezone, e.g. 2026-10-14T12:00:00Z.
          </p>{/if}
      {/if}
    </div>
  {/if}
  {#if error}<p id={`error-${field.id}`} role="alert">{error}</p>{/if}
</fieldset>

<style>
  fieldset {
    display: grid;
    gap: 0.75rem;
    border: 0;
    border-block-start: 1px solid var(--rule);
    padding: 1.25rem 0 0;
    margin: 0;
  }
  .field-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    min-block-size: 2rem;
  }
  .field-label {
    font-size: 0.8125rem;
    font-weight: 500;
  }
  .field-label small {
    display: block;
    margin-block-start: 0.25rem;
    color: var(--muted);
    font-size: 0.75rem;
    font-weight: 400;
  }
  .field-value > textarea {
    min-block-size: 3lh;
    max-block-size: 16lh;
  }
  .field-hint {
    color: var(--muted);
    font-size: 0.75rem;
    line-height: 1.6;
  }
  .field-value {
    display: grid;
    gap: 0.75rem;
  }
  label {
    display: grid;
    gap: 0.5rem;
    font-size: 0.8125rem;
  }
  .add-field,
  .omit-field {
    background: transparent;
    border-color: transparent;
    color: var(--muted);
    font-size: 0.75rem;
    gap: 0.25rem;
  }
  .add-field {
    color: var(--accent);
  }
  .omit-field {
    padding-inline: 0.375rem;
  }
  .list-item {
    display: flex;
    align-items: start;
    gap: 0.25rem;
  }
  .list-item label {
    flex: 1;
  }
  .list-item textarea {
    min-block-size: 2.25rem;
    max-block-size: 10lh;
  }
  .add-item {
    background: transparent;
    border-style: dashed;
    font-size: 0.8125rem;
  }
  [role="alert"] {
    color: var(--danger);
    font-size: 0.8125rem;
  }
  .markdown {
    container-type: inline-size;
    border: 0;
    padding: 0;
    gap: 0.5rem;
    flex: 1;
  }
  .markdown .field-heading {
    justify-content: start;
  }
  .markdown .omit-field {
    margin-inline-start: auto;
  }
  .markdown .field-label {
    color: var(--muted);
  }
  .markdown .field-value {
    gap: 1.25rem;
    align-content: start;
  }
  .markdown textarea {
    min-block-size: 18lh;
    max-block-size: 60lh;
    background: transparent;
    border: 0;
    border-radius: 0;
    padding: 0;
    font-family: ui-monospace, monospace;
    font-size: 0.9375rem;
    line-height: 1.9;
    tab-size: 2;
  }
  .markdown-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 0.5rem;
    padding-block: 0.5rem;
    border-block: 1px solid var(--rule);
  }
  .markdown-toolbar > span {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    margin-inline-end: auto;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .markdown-toolbar :global(svg) {
    inline-size: 1rem;
    block-size: 1rem;
  }
  .markdown-toolbar button {
    font-size: 0.75rem;
    padding-inline: 0.375rem;
    background: transparent;
    border-color: transparent;
    color: var(--muted);
    gap: 0.375rem;
  }
  .markdown-toolbar button[aria-pressed="true"] {
    color: var(--accent);
    background: var(--selection);
  }
  .markdown-panes {
    display: grid;
    align-items: start;
  }
  .markdown-panes.split {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 1.5rem;
  }
  .split textarea,
  .preview-panel {
    block-size: clamp(22rem, 55svh, 44rem);
    min-block-size: 0;
    max-block-size: none;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }
  .split textarea {
    field-sizing: fixed;
    resize: none;
    padding-inline-end: 0.5rem;
  }
  .preview-panel {
    border-inline-start: 1px solid var(--rule);
    padding-inline-start: 1.5rem;
    overflow-wrap: anywhere;
  }
  .preview-label {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin-block-end: 1rem;
    color: var(--muted);
    font-size: 0.75rem;
  }
  .preview-label :global(svg) {
    inline-size: 1rem;
    block-size: 1rem;
  }
  .compact-views {
    display: none;
  }
  @container (width < 38rem) {
    .compact-views {
      display: flex;
      gap: 0.25rem;
    }
    .compact-views button {
      flex: 1;
      background: transparent;
      border-color: var(--rule);
      min-block-size: 2.75rem;
    }
    .compact-views button[aria-pressed="true"] {
      background: var(--selection);
      color: var(--accent);
    }
    .markdown-panes.split {
      grid-template-columns: minmax(0, 1fr);
    }
    .split.show-preview textarea,
    .split:not(.show-preview) .preview-panel {
      display: none;
    }
    .preview-panel {
      border-inline-start: 0;
      padding-inline-start: 0;
    }
  }
  .image-picker {
    min-block-size: 3rem;
    border-style: dashed;
    background: transparent;
    font-size: 0.8125rem;
  }
  img {
    inline-size: 100%;
    block-size: auto;
    aspect-ratio: 16 / 10;
    object-fit: contain;
    border-radius: var(--radius);
    background: var(--background);
  }
  @media (pointer: coarse) {
    .markdown textarea {
      font-size: 1rem;
    }
    .omit-field {
      min-inline-size: 2.75rem;
    }
  }
</style>
