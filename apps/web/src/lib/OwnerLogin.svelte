<script lang="ts">
  import { createMutation } from "@tanstack/svelte-query";
  import { LogIn } from "lucide-svelte";
  import Wordmark from "./Wordmark.svelte";
  import { signIn } from "./auth.js";
  import { runEffect } from "./effect.js";

  let {
    onSignedIn,
    expired = false,
  }: {
    onSignedIn: () => Promise<void>;
    expired?: boolean;
  } = $props();

  let email = $state("");

  let password = $state("");

  const login = createMutation(() => ({
    mutationFn: () => runEffect(signIn(email, password)),
    retry: false,
    gcTime: 0,
    onSuccess: async () => {
      password = "";
      await onSignedIn();
    },
    onError: () => {
      password = "";
    },
  }));
</script>

<section class="login" aria-labelledby="owner-heading">
  <span class="brand"><Wordmark /></span>
  <div>
    <h1 id="owner-heading">Owner sign in</h1>
    <p>Your content, before it meets the world.</p>
  </div>
  {#if expired}
    <p role="status">Your session ended. Sign in again to continue.</p>
  {/if}
  <form
    onsubmit={(event) => {
      event.preventDefault();
      login.mutate();
    }}
  >
    <label for="owner-email">Email</label>
    <input
      id="owner-email"
      name="email"
      type="email"
      autocomplete="username"
      required
      maxlength="320"
      bind:value={email}
      disabled={login.isPending}
    />
    <label for="owner-password">Password</label>
    <input
      id="owner-password"
      name="password"
      type="password"
      autocomplete="current-password"
      required
      maxlength="1024"
      bind:value={password}
      disabled={login.isPending}
    />
    <button class="primary" type="submit" disabled={login.isPending}
      ><LogIn aria-hidden="true" />{login.isPending ? "Signing in…" : "Sign in"}</button
    >
    {#if login.isError}
      <p role="alert">Sign in failed. Check your email and password, then try again.</p>
    {/if}
  </form>
  <p class="support">
    Use the owner account created from your terminal. Password recovery is available through the
    local owner command.
  </p>
</section>

<style>
  .login {
    display: grid;
    gap: 2rem;
    inline-size: min(100%, 28rem);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    justify-self: start;
    margin-block-end: 1rem;
  }
  .login {
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: 1rem;
    padding: clamp(1.25rem, 4vw, 2.5rem);
  }
  h1 {
    font-size: 2rem;
    margin-block-end: 0.5rem;
  }
  p {
    color: var(--muted);
  }
  form {
    display: grid;
    gap: 0.65rem;
  }
  form label:not(:first-child) {
    margin-block-start: 0.75rem;
  }
  form button {
    justify-self: start;
    margin-block-start: 1rem;
  }
  .support {
    font-size: 0.875rem;
  }
</style>
