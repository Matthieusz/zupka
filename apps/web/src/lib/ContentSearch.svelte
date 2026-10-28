<script lang="ts">
  import { Command, Dialog } from "bits-ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { FileText, Search, X } from "lucide-svelte";
  import type { AdminEntry } from "@zupka/contracts";
  import type { ContentTypeDefinition } from "@zupka/shared";
  import { loadEntries, readAdmin } from "./admin.js";

  let {
    types,
    onOpen,
    onSessionLost,
  }: {
    types: readonly ContentTypeDefinition[];
    onOpen: (type: ContentTypeDefinition, entry: typeof AdminEntry.Type | null) => void;
    onSessionLost: () => Promise<void>;
  } = $props();

  let open = $state(false);

  let search = $state("");

  let debounced = $state("");

  let openingEntry = false;

  const waiting = $derived(search.trim() !== debounced);

  $effect(() => {
    const value = search.trim();

    const timer = setTimeout(() => {
      debounced = value;
    }, 200);

    return () => clearTimeout(timer);
  });

  const results = createQuery(() => ({
    queryKey: ["admin", "search", types.map((type) => type.id), debounced],
    enabled: open && debounced.length > 0,
    queryFn: async ({ signal }) => {
      const groups = [];
      const query = debounced;

      for (const type of types) {
        const page = await readAdmin(
          loadEntries(type.id, { search: query, state: "all", offset: 0 }),
          signal,
          onSessionLost,
        );

        signal.throwIfAborted();
        groups.push({ type, page });
      }

      return groups;
    },
    retry: false,
  }));

  function changeOpen(value: boolean) {
    open = value;

    if (value) openingEntry = false;

    if (!value) {
      search = "";
      debounced = "";
    }
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      changeOpen(!open);
    }
  }}
/>

<Dialog.Root {open} onOpenChange={changeOpen}>
  <Dialog.Trigger class="search-shortcut"
    ><Search aria-hidden="true" /><span>Search your content…</span><kbd>Ctrl K</kbd></Dialog.Trigger
  >
  <Dialog.Portal>
    <Dialog.Overlay class="search-overlay" />
    <Dialog.Content
      class="search-dialog"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        document.getElementById("command-search-input")?.focus();
      }}
      onCloseAutoFocus={(event) => {
        if (openingEntry) event.preventDefault();
      }}
    >
      <div class="search-header">
        <Dialog.Title class="search-title">Search content</Dialog.Title><Dialog.Close
          aria-label="Close search"><X aria-hidden="true" /></Dialog.Close
        >
      </div>
      <Dialog.Description class="search-description"
        >Find entries by title across your content types.</Dialog.Description
      >
      <Command.Root shouldFilter={false} loop vimBindings={false} label="Search entries">
        <div class="search-input">
          <Search aria-hidden="true" /><Command.Input
            id="command-search-input"
            bind:value={search}
            aria-label="Search entries"
            placeholder="Search by title…"
            maxlength={200}
          />
        </div>
        <Command.List class="search-results" aria-busy={waiting || results.isFetching}>
          {#if !search.trim()}<p class="search-feedback">Start typing to find an entry.</p>
          {:else if waiting || results.isFetching}<p class="search-feedback" role="status">
              Searching…
            </p>
          {:else if results.isError}<div class="search-feedback">
              <p role="alert">Unable to search. Check your connection and try again.</p>
              <button onclick={() => results.refetch()}>Try again</button>
            </div>
          {:else if results.data}
            {#if results.data.every((group) => group.page.total === 0)}<p
                class="search-feedback"
                role="status"
              >
                No matching entries.
              </p>{/if}
            {#each results.data as group (group.type.id)}
              {#if group.page.items.length}
                <Command.Group>
                  <Command.GroupHeading class="search-group"
                    >{group.type.label}</Command.GroupHeading
                  >
                  <Command.GroupItems>
                    {#each group.page.items as entry (entry.id)}
                      <Command.Item
                        class="search-result"
                        value={`${group.type.id}/${entry.id}`}
                        onSelect={() => {
                          openingEntry = true;
                          changeOpen(false);
                          onOpen(group.type, entry);
                        }}
                      >
                        <FileText aria-hidden="true" /><span
                          ><strong>{entry.draft.title}</strong><small>/{entry.draft.slug}</small
                          ></span
                        >
                      </Command.Item>
                    {/each}
                  </Command.GroupItems>
                  {#if group.page.total > group.page.items.length}<p class="search-feedback">
                      Showing {group.page.items.length} of {group.page.total} matches. Refine your search
                      to narrow the results.
                    </p>{/if}
                </Command.Group>
              {/if}
            {/each}
          {/if}
        </Command.List>
      </Command.Root>
      <p class="search-footer">↑ ↓ to navigate · Enter to open · Esc to close</p>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.search-shortcut) {
    display: flex;
    justify-content: start;
    gap: 0.625rem;
    inline-size: min(100%, 38rem);
    padding: 0.375rem 0.625rem;
    border: 1px solid var(--rule);
    color: var(--muted);
    background: var(--surface);
  }
  kbd {
    margin-inline-start: auto;
    font: inherit;
    font-size: 0.75rem;
    border: 1px solid var(--rule);
    border-radius: 0.25rem;
    padding-inline: 0.35rem;
  }
  :global(.search-overlay) {
    position: fixed;
    inset: 0;
    z-index: 20;
    background: oklch(0% 0 none / 0.65);
  }
  :global(.search-dialog) {
    position: fixed;
    inset-block-start: min(15dvh, 7rem);
    inset-inline: 1rem;
    margin-inline: auto;
    inline-size: min(40rem, calc(100% - 2rem));
    z-index: 21;
    background: var(--surface);
    border: 1px solid var(--rule-strong);
    border-radius: 0.875rem;
    box-shadow: 0 1.5rem 4rem oklch(0% 0 none / 0.35);
    overflow: clip;
  }
  .search-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 1rem 1rem 0.25rem;
  }
  :global(.search-title) {
    font-weight: 600;
    font-size: 1.125rem;
  }
  .search-header :global(button) {
    padding: 0.5rem;
    min-block-size: 2.75rem;
    border: 0;
    background: transparent;
  }
  :global(.search-description) {
    padding-inline: 1rem;
    color: var(--muted);
    font-size: 0.875rem;
  }
  .search-input {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 1rem;
  }
  .search-input :global(svg) {
    inline-size: 1.25rem;
    block-size: 1.25rem;
    color: var(--accent);
    flex: none;
  }
  .search-input :global(input) {
    inline-size: 100%;
  }
  :global(.search-results) {
    max-block-size: 45dvh;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0.5rem;
  }
  :global(.search-group) {
    padding: 0.5rem 0.75rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--muted);
  }
  :global(.search-result) {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.5rem 0.625rem;
    border-radius: var(--radius);
    cursor: pointer;
  }
  :global(.search-result[aria-selected="true"]) {
    background: var(--selection);
  }
  :global(.search-result:active) {
    background: var(--selection);
  }
  :global(.search-result svg) {
    inline-size: 1.25rem;
    block-size: 1.25rem;
    color: var(--accent);
    flex: none;
  }
  strong {
    display: block;
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  small {
    display: block;
    color: var(--muted);
    overflow-wrap: anywhere;
    margin-block-start: 0.25rem;
  }
  .search-feedback {
    display: grid;
    gap: 0.75rem;
    padding: 1rem;
    color: var(--muted);
    font-size: 0.875rem;
  }
  .search-feedback button {
    justify-self: start;
  }
  .search-footer {
    padding: 0.5rem 0.75rem;
    border-block-start: 1px solid var(--rule);
    color: var(--muted);
    font-size: 0.75rem;
  }
  @media (hover: hover) and (pointer: fine) {
    :global(.search-result:hover),
    .search-header :global(button:hover) {
      background: var(--selection);
    }
  }
</style>
