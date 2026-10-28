<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { FileText, Folder, Plus, ChevronDown, ChevronLeft, ChevronRight } from "lucide-svelte";
  import type { AdminEntry, PublicationState } from "@zupka/contracts";
  import type { Effect } from "effect";
  import {
    ENTRY_PAGE_SIZE,
    loadContentTypes,
    loadEntries,
    readAdmin,
    type EntryFilters,
    type AdminReadError,
  } from "./admin.js";

  let {
    type,
    onSessionLost,
    onOpen,
  }: {
    onOpen: (
      type: Effect.Success<ReturnType<typeof loadContentTypes>>[number],
      entry: typeof AdminEntry.Type | null,
    ) => void;
    type: Effect.Success<ReturnType<typeof loadContentTypes>>[number];
    onSessionLost: () => Promise<void>;
  } = $props();

  let filters = $state<EntryFilters>({ search: "", state: "all", offset: 0 });

  const states: ReadonlyArray<{ readonly value: EntryFilters["state"]; readonly label: string }> = [
    { value: "all", label: "All states" },
    { value: "unpublished", label: "Unpublished" },
    { value: "published", label: "Published" },
    { value: "published-with-draft-changes", label: "Published with draft changes" },
  ];

  const labels: Record<typeof PublicationState.Type, string> = {
    unpublished: "Unpublished",
    published: "Published",
    "published-with-draft-changes": "Published with draft changes",
  };

  const dates = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

  const entries = createQuery<Effect.Success<ReturnType<typeof loadEntries>>, AdminReadError>(
    () => ({
      queryKey: [
        "admin",
        "entries",
        type.id,
        filters.search,
        filters.state,
        ENTRY_PAGE_SIZE,
        filters.offset,
      ],
      queryFn: ({ signal }) => readAdmin(loadEntries(type.id, filters), signal, onSessionLost),
      retry: false,
    }),
  );

  function clearFilters() {
    filters = { search: "", state: "all", offset: 0 };
  }
</script>

<header class="heading">
  <span class="section-icon"
    >{#if type.id === "projects"}<Folder aria-hidden="true" />{:else}<FileText
        aria-hidden="true"
      />{/if}</span
  >
  <div>
    <h1 id="content-heading" tabindex="-1">{type.label}</h1>
  </div>
  <span class="state-control">
    <select
      class="state-filter"
      aria-label="Publication state"
      value={filters.state}
      onchange={(event) => {
        const selected = states.find((option) => option.value === event.currentTarget.value);
        if (selected) filters = { search: "", state: selected.value, offset: 0 };
      }}
    >
      {#each states as option (option.value)}<option value={option.value}>{option.label}</option
        >{/each}
    </select>
    <ChevronDown aria-hidden="true" />
  </span>
  <button class="primary" onclick={() => onOpen(type, null)}
    ><Plus aria-hidden="true" />New entry</button
  >
</header>
<section aria-label="Entries" aria-busy={entries.isFetching}>
  {#if entries.isPending}
    <div class="feedback"><p role="status">Loading entries…</p></div>
  {:else if entries.isError}
    <div class="feedback">
      <h2>Unable to load entries</h2>
      <p role="alert">
        {entries.error.reason === "forbidden"
          ? "Access was denied. Use the configured admin origin and owner account."
          : "Check your connection and try again. Your publication filter is still here."}
      </p>
      <button onclick={() => entries.refetch()}>Try again</button>
    </div>
  {:else if entries.data}
    {#if entries.data.items.length === 0}
      <div class="feedback">
        <h2>
          {filters.offset > 0
            ? "This page is empty"
            : filters.state !== "all"
              ? "No matching entries"
              : "No entries yet"}
        </h2>
        <p>
          {filters.offset > 0
            ? "The list may have changed since your last request."
            : filters.state !== "all"
              ? "Choose another publication state or show all entries."
              : `There are no saved entries in ${type.label}.`}
        </p>
        {#if filters.offset > 0}<button
            onclick={() => {
              filters = { ...filters, offset: 0 };
            }}>Return to first page</button
          >
        {:else if filters.state !== "all"}<button onclick={clearFilters}>Show all entries</button
          >{/if}
      </div>
    {:else}
      <div class="column-labels" aria-hidden="true">
        <span>Title</span><span>Tags</span><span>Publication state</span><span>Published (UTC)</span
        ><span>Updated (UTC)</span>
      </div>
      <ul class="entries">
        {#each entries.data.items as entry (entry.id)}
          {@const coverField = type.fields.find((field) => field.kind === "image")}
          {@const cover = coverField ? entry.draft.fields[coverField.id] : undefined}
          {@const tagsField = type.fields.find((field) => field.kind === "text-list")}
          {@const tags = tagsField ? entry.draft.fields[tagsField.id] : undefined}
          <li>
            <div class="entry-identity">
              {#if cover && typeof cover === "object" && "imageId" in cover}<img
                  class="thumbnail"
                  src={`/api/images/${encodeURIComponent(cover.imageId)}`}
                  alt=""
                  loading="lazy"
                />{:else}<span class="thumbnail placeholder"><FileText aria-hidden="true" /></span
                >{/if}
              <div>
                <h2 class="entry-title">
                  <button class="entry-open" onclick={() => onOpen(type, entry)}
                    >{entry.draft.title}</button
                  >
                </h2>
                <span class="slug">/{entry.draft.slug}</span>
              </div>
            </div>
            <div class="tags">
              {#if Array.isArray(tags) && tags.length}{#each tags.slice(0, 2) as tag}<span
                    >{tag}</span
                  >{/each}{#if tags.length > 2}<span>+{tags.length - 2}</span>{/if}{:else}<span
                  class="no-tags">—</span
                >{/if}
            </div>
            <p class="publication" data-state={entry.state}>{labels[entry.state]}</p>
            <span class="published-date">
              <span class="date-label">Published (UTC)</span>
              {entry.published ? dates.format(new Date(entry.published.publishedAt)) : "—"}
            </span>
            <span class="updated-date">
              <span class="date-label">Updated (UTC)</span>
              <time datetime={entry.updatedAt} title={entry.updatedAt}>
                {dates.format(new Date(entry.updatedAt))}
              </time>
            </span>
          </li>
        {/each}
      </ul>
      <nav class="pagination" aria-label="Entry pages">
        <p role="status">
          {entries.data.offset + 1}–{entries.data.offset + entries.data.items.length} of {entries
            .data.total} entries{entries.isFetching ? " · Refreshing…" : ""}
        </p>
        <button
          disabled={filters.offset === 0 || entries.isFetching}
          onclick={() => {
            filters = { ...filters, offset: Math.max(0, filters.offset - ENTRY_PAGE_SIZE) };
          }}><ChevronLeft aria-hidden="true" />Previous</button
        >
        <button
          disabled={filters.offset + ENTRY_PAGE_SIZE >= entries.data.total ||
            filters.offset + ENTRY_PAGE_SIZE > 1_000_000 ||
            entries.isFetching}
          onclick={() => {
            filters = { ...filters, offset: filters.offset + ENTRY_PAGE_SIZE };
          }}>Next<ChevronRight aria-hidden="true" /></button
        >
      </nav>
    {/if}
  {/if}
</section>

<style>
  .heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.875rem;
    margin-block: 1rem;
  }
  .heading > div {
    flex: 1;
  }
  .entry-open {
    text-align: start;
    font: inherit;
    border: 0;
    padding: 0;
    background: transparent;
    overflow-wrap: anywhere;
  }
  .state-control {
    display: grid;
    align-items: center;
    max-inline-size: 100%;
  }
  .state-filter {
    grid-area: 1 / 1;
    appearance: none;
    padding-inline-end: 2rem;
    max-inline-size: 100%;
  }
  .state-control :global(svg) {
    grid-area: 1 / 1;
    justify-self: end;
    margin-inline-end: 0.625rem;
    inline-size: 1em;
    block-size: 1em;
    pointer-events: none;
  }
  .entries {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .column-labels,
  .entries li {
    display: grid;
    grid-template-columns:
      minmax(0, 2.4fr) minmax(0, 1.2fr) minmax(0, 1.35fr) minmax(0, 0.8fr)
      minmax(0, 0.8fr);
    column-gap: 0.875rem;
    align-items: center;
  }
  .column-labels {
    padding: 0.5rem 0.75rem;
    background: var(--surface);
    border-block-end: 1px solid var(--rule);
    font-size: 0.8125rem;
    color: var(--muted);
  }
  .entries li {
    padding: 0.5rem 0.75rem;
    border-block-end: 1px solid var(--rule);
  }
  .entry-title {
    font-size: 0.875rem;
    font-weight: 500;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  section {
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    overflow: clip;
  }
  .entry-identity {
    display: flex;
    align-items: center;
    gap: 0.625rem;
  }
  .thumbnail {
    inline-size: 2.25rem;
    block-size: 2.25rem;
    object-fit: cover;
    border-radius: 0.5rem;
    flex: none;
    background: var(--surface);
  }
  .placeholder {
    display: grid;
    place-items: center;
    color: var(--muted);
  }
  .placeholder :global(svg) {
    inline-size: 1.5rem;
    block-size: 1.5rem;
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    font-size: 0.75rem;
  }
  .tags span {
    padding: 0.125rem 0.375rem;
    border-radius: 0.6rem;
    background: color-mix(in oklch, var(--foreground) 7%, transparent);
  }
  .tags .no-tags {
    background: transparent;
    color: var(--muted);
  }
  .date-label {
    display: none;
  }
  .published-date,
  .updated-date {
    color: var(--muted);
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
  }
  .slug {
    display: block;
    color: var(--muted);
    font-size: 0.875rem;
    font-weight: 400;
    margin-block-start: 0.125rem;
  }
  .publication {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    justify-self: start;
  }
  .publication::before {
    content: "";
    inline-size: 0.55rem;
    block-size: 0.55rem;
    background: currentColor;
    border-radius: 50%;
    flex: none;
  }
  .publication,
  time {
    font-size: 0.875rem;
    color: var(--muted);
  }
  .publication[data-state="published"] {
    color: var(--success);
  }
  .publication[data-state="published-with-draft-changes"] {
    color: var(--changed);
  }
  time {
    font-variant-numeric: tabular-nums;
  }
  .pagination {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    background: var(--surface);
    font-size: 0.875rem;
  }
  .pagination p {
    margin-inline-end: auto;
    color: var(--muted);
  }
  .feedback {
    display: grid;
    gap: 0.625rem;
    padding: 1.5rem 1rem;
    border-block-start: 1px solid var(--rule);
  }
  .feedback h2 {
    font-size: 1.25rem;
  }
  .feedback p {
    color: var(--muted);
    max-inline-size: 65ch;
  }
  .feedback button {
    justify-self: start;
  }
  @container (width < 56rem) {
    .column-labels {
      display: none;
    }
    .entries li {
      grid-template-columns: 1fr;
      gap: 0.25rem;
    }
    .tags:has(.no-tags) {
      display: none;
    }
    .date-label {
      display: inline;
      margin-inline-end: 0.5rem;
    }
    .publication {
      margin-block: 0.25rem;
    }
  }
</style>
