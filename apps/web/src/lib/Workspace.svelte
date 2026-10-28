<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { tick } from "svelte";
  import type { Effect } from "effect";
  import EntryList from "./EntryList.svelte";
  import Sidebar from "./Sidebar.svelte";
  import { Images } from "lucide-svelte";
  import ContentSearch from "./ContentSearch.svelte";
  import ImageLibrary from "./ImageLibrary.svelte";
  import type { AdminEntry } from "@zupka/contracts";
  import type { ContentTypeDefinition } from "@zupka/shared";
  import { loadContentTypes, readAdmin, type AdminReadError } from "./admin.js";

  let {
    onSessionLost,
    onLogout,
    signingOut,
    logoutFailed,
    onOpen,
  }: {
    onOpen: (type: ContentTypeDefinition, entry: typeof AdminEntry.Type | null) => void;
    onSessionLost: () => Promise<void>;
    onLogout: () => void;
    signingOut: boolean;
    logoutFailed: boolean;
  } = $props();

  let route = $state(globalThis.location.hash === "#main-content" ? "" : globalThis.location.hash);

  const types = createQuery<Effect.Success<ReturnType<typeof loadContentTypes>>, AdminReadError>(
    () => ({
      queryKey: ["admin", "content-types"],
      queryFn: ({ signal }) => readAdmin(loadContentTypes(), signal, onSessionLost),
      retry: false,
    }),
  );

  const selected = $derived(
    route === "" || route === "#/content"
      ? types.data?.[0]
      : types.data?.find((type) => route === `#/content/${encodeURIComponent(type.id)}`),
  );
</script>

<svelte:window
  onhashchange={async () => {
    if (globalThis.location.hash === "#main-content") return;
    route = globalThis.location.hash;
    await tick();
    document.getElementById("content-heading")?.focus();
  }}
/>

<div class="workspace">
  <Sidebar
    selected={route === "#/images" ? "images" : selected?.id}
    {onSessionLost}
    {onLogout}
    {signingOut}
    {logoutFailed}
  />
  <main id="main-content" class="content" tabindex="-1">
    <div class="context">
      {#if types.data}<ContentSearch types={types.data} {onOpen} {onSessionLost} />{/if}
    </div>
    {#if types.isPending}
      <h1 id="content-heading" tabindex="-1">Your content</h1>
      <p role="status">Loading content types…</p>
    {:else if types.isError}
      <h1 id="content-heading" tabindex="-1">Your content</h1>
      <p role="alert">
        {types.error.reason === "forbidden"
          ? "Access was denied. Use the configured admin origin and owner account."
          : "Unable to load content types. Check your connection and try again."}
      </p>
      <button onclick={() => types.refetch()}>Try again</button>
    {:else if types.data?.length === 0}
      <h1 id="content-heading" tabindex="-1">No content types configured</h1>
      <p>Add a content type in the server configuration, then restart the service.</p>
    {:else if route === "#/images"}
      <div class="image-heading">
        <span class="section-icon"><Images aria-hidden="true" /></span>
        <div>
          <h1 id="content-heading" tabindex="-1">Images</h1>
        </div>
      </div>
      <ImageLibrary {onSessionLost} />
    {:else if selected}
      {#key selected.id}<EntryList type={selected} {onSessionLost} {onOpen} />{/key}
    {:else}
      <h1 id="content-heading" tabindex="-1">Content type not found</h1>
      <p>Choose a configured content type from the navigation.</p>
    {/if}
  </main>
</div>

<style>
  .image-heading {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-block: 1rem;
  }
  .workspace {
    display: grid;
    grid-template-columns: 12.5rem minmax(0, 1fr);
    min-block-size: 100svh;
  }
  .content {
    flex: 999 1 0;
    min-inline-size: min(100%, 65%);
    padding: var(--space-page);
    container-type: inline-size;
  }
  .context {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    justify-content: space-between;
    padding-block-end: 0.75rem;
    align-items: center;
    border-block-end: 1px solid var(--rule);
    color: var(--muted);
    font-size: 0.875rem;
  }
  .content > h1 {
    margin-block-start: 1rem;
    margin-block-end: 1rem;
  }
  .content > p {
    margin-block-end: 1rem;
  }
  @media (width < 48rem) {
    .workspace {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
