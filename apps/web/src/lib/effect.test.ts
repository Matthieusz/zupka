import { QueryClient } from "@tanstack/svelte-query";
import { Deferred, Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { expect, expectTypeOf, it } from "vite-plus/test";
import type { Health } from "@zupka/contracts";
import { runEffect } from "./effect.js";
import { loadHealth } from "./health.js";

it("preserves decoded data and rejects with the original typed error", async () => {
  const failure = new Error("Expected failure");
  const fetch: typeof globalThis.fetch = async () => Response.json({ status: "ok" });
  const program = loadHealth().pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
  const result = runEffect(program);

  expectTypeOf(result).toEqualTypeOf<Promise<Health>>();
  expect(await result).toEqual({ status: "ok" });
  await expect(runEffect(Effect.fail(failure))).rejects.toBe(failure);
});

it("does not turn defects into successful results", async () => {
  await expect(runEffect(Effect.die("defect"))).rejects.toBeDefined();
});

it("cancelling a TanStack query interrupts Effect and aborts its HTTP transport", async () => {
  const started = Deferred.makeUnsafe<AbortSignal>();

  const fetch: typeof globalThis.fetch = (_input, init) => {
    const signal = init?.signal;

    if (!signal) {
      return Promise.reject(new Error("Missing transport AbortSignal"));
    }

    Effect.runSync(Deferred.succeed(started, signal));

    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  const pending = client.query({
    queryKey: ["health"],
    queryFn: ({ signal }) =>
      runEffect(loadHealth().pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)), signal),
  });

  // Attach a rejection handler before cancellation, without swallowing its outcome.
  const outcome = Promise.allSettled([pending]);

  try {
    const transportSignal = await Effect.runPromise(Deferred.await(started));

    await client.cancelQueries({ queryKey: ["health"] });

    expect(transportSignal.aborted).toBe(true);
    expect(await outcome).toMatchObject([{ status: "rejected" }]);
    expect(client.getQueryState(["health"])?.fetchStatus).toBe("idle");
    expect(client.getQueryData(["health"])).toBeUndefined();
  } finally {
    client.clear();
  }
});

it("honors an already aborted signal without executing the request", async () => {
  const controller = new AbortController();
  let executed = false;

  controller.abort();

  await expect(
    runEffect(
      Effect.sync(() => {
        executed = true;
      }),
      controller.signal,
    ),
  ).rejects.toBeDefined();
  expect(executed).toBe(false);
});
