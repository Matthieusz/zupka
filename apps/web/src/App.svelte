<script lang="ts">
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import type { Health } from "@zupka/contracts";
  import type { Effect } from "effect";
  import ExampleDialog from "./lib/ExampleDialog.svelte";
  import { runEffect } from "./lib/effect.js";
  import { loadHealth } from "./lib/health.js";

  type HealthError = Effect.Error<ReturnType<typeof loadHealth>>;

  const queryClient = useQueryClient();

  let enabled = $state(true);

  // This endpoint has no parameters: one stable key identifies its server data.
  const health = createQuery<Health, HealthError>(() => ({
    queryKey: ["health"],
    queryFn: ({ signal }) => runEffect(loadHealth(), signal),
    enabled,
  }));

  // Manual command against the existing read-only endpoint, not a server write.
  // Real writes use the same mutation + awaited invalidation pattern.
  const checkHealth = createMutation<Health, HealthError>(() => ({
    mutationFn: () => runEffect(loadHealth()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["health"] }),
  }));
</script>

<main class="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-6 px-6 py-16">
  <p class="text-sm font-medium tracking-widest text-lime-400 uppercase">Zupka scaffold</p>
  <h1 class="text-4xl font-semibold tracking-tight sm:text-5xl">A small place to start.</h1>
  <p class="text-lg text-zinc-400">Svelte 5, Bits UI, Tailwind CSS, and an Effect API.</p>

  <section aria-label="Backend health" class="flex flex-col gap-3">
    <label class="flex items-center gap-2 text-sm text-zinc-300">
      <input
        type="checkbox"
        checked={enabled}
        onchange={async (event) => {
          enabled = event.currentTarget.checked;

          if (!enabled) {
            await queryClient.cancelQueries({ queryKey: ["health"] });
          }
        }}
        class="accent-lime-400"
      />
      Enable health query
    </label>

    <div role="status" class="text-sm text-zinc-300">
      {#if health.isLoading}
        Checking backend…
      {:else if health.isError}
        Backend unavailable. Please try again.
      {:else if health.isSuccess}
        Backend connected ({health.data.status})
      {:else}
        No health data yet.
      {/if}
    </div>

    {#if health.isFetching && !health.isLoading}
      <p class="text-sm text-zinc-400">Refreshing backend status…</p>
    {/if}

    <button
      onclick={() => checkHealth.mutate()}
      disabled={checkHealth.isPending}
      class="w-fit rounded-lg border border-zinc-600 px-4 py-2 text-sm hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-50"
    >
      {checkHealth.isPending ? "Checking…" : "Run manual health check"}
    </button>
    {#if checkHealth.isError}
      <p role="alert" class="text-sm text-red-400">Manual check failed. Please try again.</p>
    {:else if checkHealth.isSuccess}
      <p class="text-sm text-lime-400">Manual check succeeded.</p>
    {/if}
  </section>

  <ExampleDialog />
</main>
