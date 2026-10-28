<script lang="ts">
  import { QueryClientProvider, type QueryClient } from "@tanstack/svelte-query";
  import { onDestroy } from "svelte";
  import App from "../App.svelte";

  let { cache }: { cache: QueryClient } = $props();

  onDestroy(() => cache.clear());
</script>

<QueryClientProvider client={cache}><App /></QueryClientProvider>
