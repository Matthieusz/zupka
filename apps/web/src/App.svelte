<script lang="ts">
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { tick } from "svelte";
  import OwnerLogin from "./lib/OwnerLogin.svelte";
  import EntryEditor from "./lib/EntryEditor.svelte";
  import type { AdminEntry } from "@zupka/contracts";
  import type { ContentTypeDefinition } from "@zupka/shared";
  import Workspace from "./lib/Workspace.svelte";
  import { loadSession, signOut } from "./lib/auth.js";
  import { runEffect } from "./lib/effect.js";

  const cache = useQueryClient();

  let expired = $state(false);

  let editor = $state<{ type: ContentTypeDefinition; entry: typeof AdminEntry.Type | null } | null>(
    null,
  );

  let hadSession = false;

  async function clearProtected() {
    await cache.cancelQueries({ queryKey: ["admin"] });
    cache.removeQueries({ queryKey: ["admin"] });
  }

  const session = createQuery(() => ({
    queryKey: ["owner-session"],
    queryFn: async ({ signal }) => {
      const value = await runEffect(loadSession(), signal);
      signal.throwIfAborted();

      if (value === null) {
        expired = hadSession;
        await clearProtected();
      } else {
        hadSession = true;
        expired = false;
      }

      return value;
    },
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    // Check idle foreground tabs too; every management read is still authorized by the server.
    refetchInterval: 60_000,
  }));

  async function sessionLost() {
    expired = true;
    await cache.cancelQueries({ queryKey: ["owner-session"] });
    cache.setQueryData(["owner-session"], null);
    await clearProtected();
  }

  async function signedIn() {
    await clearProtected();
    await cache.invalidateQueries({ queryKey: ["owner-session"] });
  }

  const logout = createMutation(() => ({
    mutationFn: () => runEffect(signOut()),
    retry: false,
    gcTime: 0,
    onSuccess: async () => {
      hadSession = false;
      expired = false;
      await cache.cancelQueries({ queryKey: ["owner-session"] });
      cache.setQueryData(["owner-session"], null);
      await clearProtected();
    },
  }));
</script>

<a
  class="skip-link"
  href="#main-content"
  onclick={(event) => {
    event.preventDefault();
    document.getElementById("main-content")?.focus();
  }}>Skip to content</a
>
{#if session.isPending}
  <main id="main-content" class="auth-screen" tabindex="-1">
    <p role="status">Checking your session…</p>
  </main>
{:else if session.isError}
  <main id="main-content" class="auth-screen" tabindex="-1">
    <section class="session-error">
      <h1>Unable to check your session</h1>
      <p role="alert">
        Check your connection and try again. Protected content is hidden until your session can be
        verified.
      </p>
      <button onclick={() => session.refetch()}>Try again</button>
    </section>
  </main>
{:else if session.data && !expired}
  {#if !editor}<Workspace
      onOpen={(type, entry) => {
        editor = { type, entry };
      }}
      onSessionLost={sessionLost}
      onLogout={() => logout.mutate()}
      signingOut={logout.isPending}
      logoutFailed={logout.isError}
    />{/if}
  {#if logout.isError && editor}<p role="alert">Sign out failed. Please try again.</p>{/if}
{:else}
  <main id="main-content" class="auth-screen" tabindex="-1">
    <OwnerLogin onSignedIn={signedIn} {expired} />
  </main>
{/if}

{#if editor}
  <div hidden={!session.data || expired || session.isError}>
    <EntryEditor
      type={editor.type}
      initial={editor.entry}
      active={Boolean(session.data) && !expired && !session.isError}
      onClose={async () => {
        editor = null;
        await tick();
        document.getElementById("content-heading")?.focus();
      }}
      onSessionLost={sessionLost}
      onLogout={() => logout.mutate()}
    />
  </div>
{/if}

<style>
  .auth-screen {
    display: grid;
    place-items: center;
    align-content: center;
    min-block-size: 100svh;
    padding: var(--space-page);
  }
  .session-error {
    display: grid;
    gap: 1rem;
    max-inline-size: 34rem;
  }
  .session-error button {
    justify-self: start;
  }
</style>
