<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { FileText, Folder, Images, LogOut } from "lucide-svelte";
  import Wordmark from "./Wordmark.svelte";
  import { loadContentTypes, readAdmin } from "./admin.js";

  let {
    selected,
    onSessionLost,
    onLogout,
    signingOut = false,
    logoutFailed = false,
  }: {
    selected: string | undefined;
    onSessionLost: () => Promise<void>;
    onLogout: () => void;
    signingOut?: boolean;
    logoutFailed?: boolean;
  } = $props();

  const types = createQuery(() => ({
    queryKey: ["admin", "content-types"],
    queryFn: ({ signal }) => readAdmin(loadContentTypes(), signal, onSessionLost),
    retry: false,
  }));
</script>

<aside class="rail">
  <a class="brand" href="#/content" aria-label="Zupka"><Wordmark /></a>
  <nav aria-label="Content types">
    {#each types.data ?? [] as type (type.id)}
      <a
        href={`#/content/${encodeURIComponent(type.id)}`}
        aria-current={selected === type.id ? "page" : undefined}
      >
        {#if type.id === "projects"}<Folder aria-hidden="true" />{:else}<FileText
            aria-hidden="true"
          />{/if}
        <span>{type.label}</span>
      </a>
    {/each}
    <a href="#/images" aria-current={selected === "images" ? "page" : undefined}
      ><Images aria-hidden="true" /><span>Images</span></a
    >
  </nav>
  <div class="account">
    <div class="owner">
      <span class="avatar">M</span><span>Owner</span>
    </div>
    <button disabled={signingOut} onclick={onLogout}
      ><LogOut aria-hidden="true" />{signingOut ? "Signing out…" : "Sign out"}</button
    >
    {#if logoutFailed}<p role="alert">Sign out failed. Please try again.</p>{/if}
  </div>
</aside>

<style>
  .rail {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    padding: 1rem 0.625rem;
    background: var(--rail);
    border-inline-end: 1px solid var(--rule);
    position: sticky;
    inset-block-start: 0;
    block-size: 100dvh;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .brand {
    display: flex;
    align-items: center;
    padding-inline: 0.65rem;
  }
  nav {
    display: grid;
    gap: 0.25rem;
  }
  nav a {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.5rem 0.625rem;
    border-radius: var(--radius);
  }
  nav a[aria-current="page"] {
    background: var(--selection);
  }
  nav a[aria-current="page"] :global(svg) {
    color: var(--accent);
  }
  nav :global(svg),
  .account :global(svg) {
    inline-size: 1.25em;
    block-size: 1.25em;
    flex: none;
    stroke-width: 1.7;
  }
  .account {
    display: grid;
    gap: 0.5rem;
    margin-block-start: auto;
    border-block-start: 1px solid var(--rule);
    padding-block-start: 0.75rem;
    font-size: 0.875rem;
  }
  .owner {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding-inline: 0.5rem;
  }
  .account button {
    border: 0;
    background: transparent;
    justify-content: start;
  }
  .account button:active:not(:disabled) {
    background: var(--selection);
    color: var(--accent);
  }
  @media (hover: hover) and (pointer: fine) {
    .account button:hover:not(:disabled) {
      background: var(--selection);
      color: var(--accent);
    }
  }
  @media (width < 48rem) {
    .rail {
      position: static;
      block-size: auto;
      overflow-y: visible;
      gap: 1rem;
      border-inline-end: 0;
      border-block-end: 1px solid var(--rule);
    }
    nav {
      display: flex;
      flex-wrap: wrap;
    }
    .account {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      margin-block-start: 0;
    }
    .owner {
      margin-inline-end: auto;
    }
  }
</style>
