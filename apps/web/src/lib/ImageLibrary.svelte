<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { Upload, Trash2 } from "lucide-svelte";
  import type { ManagedImage } from "@zupka/contracts";
  import { MaximumImageBytes } from "@zupka/shared";
  import { Schema } from "effect";
  import { listImages, uploadImage, deleteImage, EditorError, editorMessages } from "./editing.js";
  import { runEffect } from "./effect.js";

  let {
    onSessionLost,
  }: {
    onSessionLost: () => Promise<void>;
  } = $props();

  const cache = useQueryClient();

  let offset = $state(0);

  let message = $state("");

  let file = $state<File | null>(null);

  let fileInput = $state<HTMLInputElement>();

  const images = createQuery(() => ({
    queryKey: ["admin", "images", 20, offset],
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

  // UI failure ingress; raw errors are never rendered.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  async function report(error: unknown) {
    message = Schema.is(EditorError)(error)
      ? editorMessages[error.reason]
      : editorMessages.unavailable;

    if (Schema.is(EditorError)(error) && error.reason === "session-expired") await onSessionLost();
  }

  const mutation = createMutation(() => ({
    mutationFn: async (
      command: { kind: "upload"; file: File } | { kind: "delete"; image: typeof ManagedImage.Type },
    ) => {
      message = "";

      if (command.kind === "upload") return await runEffect(uploadImage(command.file));
      await runEffect(deleteImage(command.image.id));

      return null;
    },
    retry: false,
    gcTime: 0,
    onSuccess: async (image) => {
      if (image) {
        message = "Uploaded. This image is private until a published entry references it.";
        file = null;

        if (fileInput) fileInput.value = "";
        offset = 0;
      } else message = "Image permanently deleted.";
      await cache.invalidateQueries({ queryKey: ["admin", "images"] });
    },
    onError: report,
  }));
</script>

<section class="library" aria-label="Image library">
  <h2>Image library</h2>
  <p>JPEG, PNG, WebP or GIF · Up to 10 MiB. New uploads are private.</p>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      if (!file) return;
      if (file.size > MaximumImageBytes) {
        message = editorMessages["image-too-large"];
        return;
      }
      mutation.mutate({ kind: "upload", file });
    }}
  >
    <label
      >Image file<input
        type="file"
        bind:this={fileInput}
        disabled={mutation.isPending}
        accept="image/jpeg,image/png,image/webp,image/gif"
        onchange={(event) => {
          file = event.currentTarget.files?.[0] ?? null;
        }}
      /></label
    >
    <button class="primary" disabled={!file || mutation.isPending}
      ><Upload aria-hidden="true" />Upload image</button
    >
  </form>
  {#if message}<p role={mutation.isError ? "alert" : "status"}>{message}</p>{/if}
  {#if mutation.isPending}<p role="status">Working…</p>{/if}
  {#if images.isPending}<p role="status">Loading images…</p>
  {:else if images.isError}<p role="alert">Unable to load the image library.</p>
    <button onclick={() => images.refetch()}>Try again</button>
  {:else if images.data}
    {#if images.data.items.length === 0}<p>No images on this page.</p>{/if}
    <ul>
      {#each images.data.items as image (image.id)}
        <li>
          {#if image.state === "active"}<img src={image.url} alt="" loading="lazy" />{/if}
          <p>{image.mediaType} · {image.width} × {image.height}</p>
          <p class="identity">{image.id}</p>
          <div class="actions">
            <button
              type="button"
              disabled={mutation.isPending}
              onclick={() => {
                if (
                  confirm(
                    "Permanently delete this image? This cannot be undone. Saved references will block deletion.",
                  )
                )
                  mutation.mutate({ kind: "delete", image });
              }}
              ><Trash2 aria-hidden="true" />{image.state === "deleting"
                ? "Retry deletion"
                : "Delete image"}</button
            >
          </div>
        </li>
      {/each}
    </ul>
    <nav class="actions" aria-label="Image pages">
      <button
        disabled={offset === 0 || images.isFetching}
        onclick={() => {
          offset = Math.max(0, offset - 20);
        }}>Previous images</button
      >
      <button
        disabled={offset + 20 >= images.data.total || images.isFetching}
        onclick={() => {
          offset += 20;
        }}>Next images</button
      >
    </nav>
  {/if}
</section>

<style>
  .library {
    display: grid;
    gap: 0.625rem;
  }
  h2 {
    font-size: 1.125rem;
  }
  p {
    color: var(--muted);
  }
  [role="alert"] {
    color: var(--danger);
  }
  form {
    padding: 0.75rem;
    border: 1px dashed var(--rule-strong);
    border-radius: 0.75rem;
    background: var(--surface);
  }
  form,
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    align-items: end;
  }
  label {
    display: grid;
    gap: 0.375rem;
  }
  input {
    max-inline-size: 100%;
  }
  ul {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 12rem), 1fr));
    gap: 0.375rem;
    list-style: none;
    padding: 0;
    margin: 0;
  }
  li {
    display: grid;
    gap: 0.375rem;
    align-content: start;
    padding: 0.625rem;
    border: 1px solid var(--rule);
    border-radius: 0.75rem;
    background: var(--surface);
  }
  img {
    inline-size: 100%;
    block-size: auto;
    border-radius: var(--radius);
    aspect-ratio: 4 / 3;
    object-fit: contain;
    background: var(--rail);
  }
  .identity {
    overflow-wrap: anywhere;
    font-size: 0.875rem;
  }
</style>
