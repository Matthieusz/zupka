<script lang="ts">
  import { Dialog } from "bits-ui";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { tick } from "svelte";
  import { Schema } from "effect";
  import type { ManagedImage } from "@zupka/contracts";
  import { MaximumImageBytes } from "@zupka/shared";
  import { X, Images, Upload, Check, ArrowLeft, ImagePlus } from "lucide-svelte";
  import { listImages, uploadImage, EditorError, editorMessages } from "./editing.js";
  import { runEffect } from "./effect.js";

  let {
    open,
    action,
    fieldLabel,
    onCancel,
    onSelect,
    onSessionLost,
  }: {
    open: boolean;
    action: "Insert image" | "Choose image" | "Replace image";
    fieldLabel: string;
    onCancel: () => Promise<void>;
    onSelect: (image: typeof ManagedImage.Type, alt: string) => Promise<void>;
    onSessionLost: () => Promise<void>;
  } = $props();

  let offset = $state(0);

  let view = $state<"library" | "upload">("library");

  let selected = $state<typeof ManagedImage.Type | null>(null);

  let reviewing = $state(false);

  let focusAfterUpload = $state(false);

  let alt = $state("");

  let decorative = $state(false);

  let file = $state<File | null>(null);

  let feedback = $state<{ kind: "alert" | "status"; text: string } | null>(null);

  const cache = useQueryClient();

  $effect(() => {
    if (open) {
      offset = 0;
      view = "library";
      selected = null;
      reviewing = false;
      focusAfterUpload = false;
      alt = "";
      decorative = false;
      file = null;
      feedback = null;
    }
  });

  // UI failure boundary: never render raw transport errors.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  async function report(error: unknown) {
    feedback = {
      kind: "alert",
      text: Schema.is(EditorError)(error)
        ? editorMessages[error.reason]
        : editorMessages.unavailable,
    };

    if (Schema.is(EditorError)(error) && error.reason === "session-expired") await onSessionLost();
  }

  const images = createQuery(() => ({
    queryKey: ["admin", "images", 20, offset],
    enabled: open,
    queryFn: async ({ signal }) => {
      try {
        return await runEffect(listImages(offset), signal);
      } catch (error) {
        signal.throwIfAborted();
        await report(error);
        throw error;
      }
    },
    retry: false,
  }));

  async function select(image: typeof ManagedImage.Type) {
    if (selected?.id !== image.id) {
      alt = "";
      decorative = false;
    }

    selected = image;
    reviewing = true;
    await tick();

    if (upload.isPending) focusAfterUpload = true;
    else
      document
        .getElementById(decorative ? "picker-decorative" : "picker-alt")
        ?.focus({ preventScroll: true });
  }

  const upload = createMutation(() => ({
    mutationFn: (file: File) => runEffect(uploadImage(file)),
    retry: false,
    gcTime: 0,
    onSuccess: async (image) => {
      file = null;
      offset = 0;
      view = "library";
      feedback = {
        kind: "status",
        text: "Uploaded. Review the image before inserting. Cancelling keeps this upload in your library.",
      };
      await select(image);
      await cache.invalidateQueries({ queryKey: ["admin", "images"] });
    },
    onError: report,
  }));

  $effect(() => {
    if (open && focusAfterUpload && !upload.isPending) {
      focusAfterUpload = false;
      document.getElementById("picker-alt")?.focus({ preventScroll: true });
    }
  });

  const canInsert = $derived(
    view === "library" &&
      selected !== null &&
      (decorative || alt.trim().length > 0) &&
      !upload.isPending,
  );
</script>

<Dialog.Root
  {open}
  onOpenChange={(value) => {
    if (!value && !upload.isPending) return onCancel();
  }}
>
  <Dialog.Portal>
    <Dialog.Overlay class="image-picker-overlay" />
    <Dialog.Content
      class="image-picker-dialog"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        document.getElementById("image-picker-title")?.focus();
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
      }}
      onEscapeKeydown={(event) => {
        if (upload.isPending) event.preventDefault();
      }}
      onInteractOutside={(event) => {
        if (upload.isPending) event.preventDefault();
      }}
    >
      <header class="picker-header">
        <div>
          <Dialog.Title id="image-picker-title" tabindex={-1} class="picker-title"
            >{action}</Dialog.Title
          >
          <Dialog.Description class="picker-description"
            >Choose an image for {fieldLabel.toLowerCase()}. Your entry changes only when you
            confirm.</Dialog.Description
          >
        </div>
        <Dialog.Close aria-label="Close image selection" disabled={upload.isPending}
          ><X aria-hidden="true" /></Dialog.Close
        >
      </header>
      <div class="picker-views" role="group" aria-label="Image source">
        <button
          id="picker-library-view"
          type="button"
          aria-pressed={view === "library"}
          disabled={upload.isPending}
          onclick={() => {
            view = "library";
            reviewing = false;
          }}><Images aria-hidden="true" />Library</button
        >
        <button
          type="button"
          aria-pressed={view === "upload"}
          disabled={upload.isPending}
          onclick={() => {
            if (view !== "upload") file = null;
            view = "upload";
          }}><Upload aria-hidden="true" />Upload</button
        >
      </div>
      {#if feedback}<p class="picker-feedback" role={feedback.kind}>{feedback.text}</p>{/if}
      <div class="picker-body" data-review={reviewing && selected !== null && view === "library"}>
        <section
          class="picker-browser"
          aria-label={view === "library" ? "Image library" : "Upload image"}
        >
          {#if view === "upload"}
            <form
              class="picker-upload"
              onsubmit={(event) => {
                event.preventDefault();
                if (!file || upload.isPending) return;
                if (file.size > MaximumImageBytes) {
                  feedback = { kind: "alert", text: editorMessages["image-too-large"] };
                  return;
                }
                feedback = null;
                upload.mutate(file);
              }}
            >
              <Upload aria-hidden="true" />
              <h3>Bring a new image into your library</h3>
              <p>JPEG, PNG, WebP or GIF · Up to 10 MiB</p>
              <label
                >Image file<input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  disabled={upload.isPending}
                  onchange={(event) => {
                    file = event.currentTarget.files?.[0] ?? null;
                  }}
                /></label
              >
              <button class="primary" disabled={!file || upload.isPending}
                ><Upload aria-hidden="true" />{upload.isPending
                  ? "Uploading…"
                  : "Upload image"}</button
              >
              <p>New uploads are private until a published entry references them.</p>
            </form>
          {:else if images.isPending}<p class="picker-empty" role="status">Loading images…</p>
          {:else if images.isError}<div class="picker-empty">
              <p role="alert">Unable to load the image library.</p>
              <button
                onclick={() => {
                  feedback = null;
                  return images.refetch();
                }}>Try again</button
              >
            </div>
          {:else if images.data}
            {#if images.data.items.length === 0}
              <div class="picker-empty">
                <Images aria-hidden="true" />
                <h3>
                  {images.data.total === 0
                    ? "Your image library is empty"
                    : "No images on this page"}
                </h3>
                <p>Upload an image to use it in this entry.</p>
                <button
                  onclick={() => {
                    view = "upload";
                  }}>Upload an image</button
                >
              </div>
            {/if}
            <ul class="picker-grid">
              {#each images.data.items as image, index (image.id)}
                <li>
                  <button
                    type="button"
                    class="picker-thumbnail"
                    aria-label={`Select image ${offset + index + 1} · ${image.width} by ${image.height}`}
                    aria-pressed={selected?.id === image.id}
                    disabled={image.state !== "active" || upload.isPending}
                    onclick={() => select(image)}
                  >
                    <span class="thumbnail-image"
                      ><img
                        src={image.url}
                        alt=""
                        loading="lazy"
                      />{#if selected?.id === image.id}<span class="selected-check"
                          ><Check aria-hidden="true" /></span
                        >{/if}</span
                    >
                    <span class="thumbnail-meta"
                      >{image.width} × {image.height}<span
                        >{image.state === "active"
                          ? image.mediaType.slice(6).toUpperCase()
                          : "Unavailable"}</span
                      ></span
                    >
                  </button>
                </li>
              {/each}
            </ul>
            {#if images.data.total > 20 || offset > 0}<nav
                class="picker-pagination"
                aria-label="Image pages"
              >
                <button
                  disabled={offset === 0 || images.isFetching}
                  onclick={() => {
                    offset = Math.max(0, offset - 20);
                  }}>Previous images</button
                >
                <span>Page {Math.floor(offset / 20) + 1}</span>
                <button
                  disabled={offset + 20 >= images.data.total || images.isFetching}
                  onclick={() => {
                    offset += 20;
                  }}>Next images</button
                >
              </nav>{/if}
          {/if}
        </section>
        <aside class="picker-details" aria-label="Selected image details">
          {#if selected}
            <button
              class="back-to-library"
              type="button"
              onclick={async () => {
                reviewing = false;
                view = "library";
                await tick();
                const thumbnail = document.querySelector<HTMLButtonElement>(
                  '.picker-thumbnail[aria-pressed="true"]',
                );
                (thumbnail ?? document.getElementById("picker-library-view"))?.focus();
              }}><ArrowLeft aria-hidden="true" />Back to library</button
            >
            <h3>Selected image</h3>
            <div class="selected-preview"><img src={selected.url} alt="" /></div>
            <p class="selected-meta">
              {selected.width} × {selected.height} · {selected.mediaType.slice(6).toUpperCase()} · {Math.max(
                1,
                Math.round(selected.bytes / 1024),
              )} KB
            </p>
            <label for="picker-alt">Alt text for selected image</label>
            <textarea
              id="picker-alt"
              rows="3"
              bind:value={alt}
              disabled={decorative || upload.isPending}
              aria-required={!decorative}
              aria-describedby="picker-alt-help"></textarea>
            <p id="picker-alt-help">
              Describe what matters in this image. This description belongs to this entry, not the
              library.
            </p>
            <label class="decorative-choice"
              ><input
                id="picker-decorative"
                type="checkbox"
                bind:checked={decorative}
                disabled={upload.isPending}
              />This image is decorative</label
            >
            {#if decorative}<p>
                Inserted with empty alt text so assistive technology can skip it.
              </p>{/if}
          {:else}<div class="selection-empty">
              <ImagePlus aria-hidden="true" />
              <h3>Select an image</h3>
              <p>Choose a thumbnail to preview it and add an image description.</p>
            </div>{/if}
        </aside>
      </div>
      <footer class="picker-footer">
        <p role="status">
          {upload.isPending
            ? "Uploading. Keep this window open…"
            : selected
              ? "1 image selected"
              : "No image selected"}
        </p>
        <Dialog.Close disabled={upload.isPending}>Cancel</Dialog.Close>
        <button
          type="button"
          class="primary"
          disabled={!canInsert}
          onclick={async () => {
            if (selected && canInsert) await onSelect(selected, decorative ? "" : alt);
          }}><ImagePlus aria-hidden="true" />{action}</button
        >
      </footer>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.image-picker-overlay) {
    position: fixed;
    inset: 0;
    z-index: 30;
    background: oklch(0% 0 none / 0.7);
  }
  :global(.image-picker-dialog) {
    position: fixed;
    inset: 0;
    margin: auto;
    inline-size: min(68rem, calc(100% - 3rem));
    block-size: min(48rem, calc(100dvh - 3rem));
    display: flex;
    flex-direction: column;
    z-index: 31;
    border: 1px solid var(--rule-strong);
    border-radius: 0.75rem;
    background: var(--background);
    box-shadow: 0 1.5rem 5rem oklch(0% 0 none / 0.45);
    overflow: clip;
    container-type: inline-size;
  }
  .picker-header {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 1rem;
    padding: 1.5rem 1.5rem 1rem;
    flex: none;
  }
  :global(.picker-title) {
    font-size: 1.375rem;
    font-weight: 600;
    letter-spacing: -0.025em;
  }
  :global(.picker-description) {
    margin-block-start: 0.375rem;
    color: var(--muted);
    font-size: 0.8125rem;
  }
  .picker-header :global(button) {
    min-inline-size: 2.75rem;
    min-block-size: 2.75rem;
    background: transparent;
    border-color: var(--rule);
  }
  .picker-views {
    display: flex;
    gap: 0.375rem;
    padding: 0 1.5rem 1rem;
    flex: none;
    border-block-end: 1px solid var(--rule);
  }
  .picker-views button {
    background: transparent;
    border-color: transparent;
    min-block-size: 2.75rem;
  }
  .picker-views button[aria-pressed="true"] {
    color: var(--accent);
    background: var(--selection);
  }
  .picker-feedback {
    margin: 0;
    padding: 0.75rem 1.5rem;
    border-block-end: 1px solid var(--rule);
    font-size: 0.8125rem;
    flex: none;
  }
  .picker-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 20rem;
    min-block-size: 0;
    flex: 1;
  }
  .picker-browser,
  .picker-details {
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
    padding: 1.5rem;
  }
  .picker-details {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    border-inline-start: 1px solid var(--rule);
    background: var(--rail);
  }
  h3 {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
  }
  p {
    color: var(--muted);
    font-size: 0.8125rem;
    line-height: 1.65;
  }
  [role="alert"] {
    color: var(--danger);
  }
  .picker-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 9rem), 1fr));
    align-content: start;
    gap: 1rem;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .picker-thumbnail {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: 0;
    inline-size: 100%;
    text-align: start;
    background: var(--surface);
    border: 1px solid var(--rule);
    overflow: clip;
  }
  .picker-thumbnail[aria-pressed="true"] {
    border-color: var(--accent);
    background: var(--selection);
  }
  .thumbnail-image {
    display: grid;
    inline-size: 100%;
    aspect-ratio: 4 / 3;
    padding: 0.5rem;
  }
  .thumbnail-image > * {
    grid-area: 1 / 1;
  }
  .thumbnail-image img {
    inline-size: 100%;
    block-size: 100%;
    min-block-size: 0;
    object-fit: contain;
  }
  .selected-check {
    place-self: start end;
    background: var(--accent);
    color: var(--background);
    border-radius: 50%;
    padding: 0.25rem;
    display: inline-flex;
  }
  .selected-check :global(svg) {
    inline-size: 0.875rem;
    block-size: 0.875rem;
  }
  .thumbnail-meta {
    inline-size: 100%;
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.25rem;
    padding: 0.625rem;
    font-size: 0.6875rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    border-block-start: 1px solid var(--rule);
  }
  .picker-pagination {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-block-start: 1.5rem;
  }
  .picker-pagination span {
    color: var(--muted);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }
  .picker-pagination button {
    font-size: 0.75rem;
  }
  .selected-preview {
    aspect-ratio: 4 / 3;
    display: grid;
    place-items: center;
    background: var(--surface);
    border-radius: var(--radius);
    padding: 0.75rem;
  }
  .selected-preview img {
    inline-size: 100%;
    block-size: 100%;
    min-block-size: 0;
    object-fit: contain;
  }
  .selected-meta {
    font-variant-numeric: tabular-nums;
    font-size: 0.75rem;
  }
  label {
    font-size: 0.8125rem;
    font-weight: 500;
  }
  textarea {
    min-block-size: 4lh;
    max-block-size: 8lh;
  }
  .decorative-choice {
    display: flex;
    align-items: start;
    gap: 0.625rem;
    font-weight: 400;
  }
  .decorative-choice input {
    inline-size: 1rem;
    min-block-size: 1rem;
    block-size: 1rem;
    margin: 0;
    margin-block-start: 0.125rem;
    accent-color: var(--accent);
  }
  .picker-footer {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 1rem 1.5rem;
    border-block-start: 1px solid var(--rule);
    flex: none;
  }
  .picker-footer p {
    margin-inline-end: auto;
    font-size: 0.75rem;
  }
  .picker-footer :global(button) {
    min-block-size: 2.75rem;
  }
  .selection-empty,
  .picker-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    justify-content: center;
    gap: 0.875rem;
    min-block-size: 15rem;
  }
  .selection-empty {
    flex: 1;
  }
  .selection-empty :global(svg),
  .picker-empty :global(svg) {
    inline-size: 2rem;
    block-size: 2rem;
    color: var(--muted);
  }
  .picker-upload {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    border: 1px dashed var(--rule-strong);
    border-radius: var(--radius);
    padding: clamp(1.25rem, 4cqi, 3rem);
    text-align: center;
  }
  .picker-upload > :global(svg) {
    inline-size: 2rem;
    block-size: 2rem;
    color: var(--accent);
  }
  .picker-upload label {
    display: grid;
    gap: 0.75rem;
    inline-size: 100%;
    text-align: start;
  }
  .picker-upload input {
    inline-size: 100%;
    padding: 0.75rem;
  }
  .picker-upload input::file-selector-button {
    color: var(--foreground);
    background: var(--surface);
    border: 1px solid var(--rule-strong);
    border-radius: var(--radius);
    padding: 0.5rem;
    margin-inline-end: 0.75rem;
    cursor: pointer;
  }
  .back-to-library {
    display: none;
  }
  @media (width < 48rem) {
    :global(.image-picker-dialog) {
      inline-size: 100%;
      block-size: 100dvh;
      border: 0;
      border-radius: 0;
    }
  }
  @container (width < 42rem) {
    .picker-body {
      grid-template-columns: minmax(0, 1fr);
    }
    .picker-details {
      display: none;
      border-inline-start: 0;
    }
    .picker-body[data-review="true"] .picker-browser {
      display: none;
    }
    .picker-body[data-review="true"] .picker-details {
      display: flex;
    }
    .back-to-library {
      display: inline-flex;
      align-self: start;
      background: transparent;
      border-color: var(--rule);
      min-block-size: 2.75rem;
    }
    .picker-header {
      padding: 1rem;
    }
    .picker-views {
      padding-inline: 1rem;
    }
    .picker-browser,
    .picker-details {
      padding: 1rem;
    }
    .picker-footer {
      padding: 0.75rem 1rem;
    }
    .picker-footer p {
      display: none;
    }
    .picker-footer :global(button) {
      flex: 1;
    }
    .selected-preview {
      max-block-size: 12rem;
    }
  }
  @media (hover: hover) and (pointer: fine) {
    .picker-thumbnail:hover:not(:disabled) {
      border-color: var(--accent);
    }
  }
</style>
