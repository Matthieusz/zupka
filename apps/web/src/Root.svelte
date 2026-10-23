<script lang="ts">
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import { onDestroy } from "svelte";
  import App from "./App.svelte";

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
        refetchOnMount: true,
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
      },
      mutations: { retry: false },
    },
  });

  onDestroy(() => queryClient.clear());
</script>

<QueryClientProvider client={queryClient}>
  <App />
</QueryClientProvider>
