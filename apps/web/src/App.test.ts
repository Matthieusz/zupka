import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { Deferred, Effect } from "effect";
import { afterAll, beforeAll, expect, it, vi } from "vite-plus/test";
import Root from "./Root.svelte";

let transport: typeof globalThis.fetch = async () => Response.error();

// Effect caches the default Fetch reference. Install one stable platform
// transport, then vary its responses; no module mocks or internal spies.
beforeAll(() => {
  const fetch: typeof globalThis.fetch = (...args) => transport(...args);

  vi.stubGlobal("fetch", fetch);
});

afterAll(() => vi.unstubAllGlobals());

it("loads health, then invalidates and refetches after a manual check", async () => {
  let requests = 0;
  const firstResponse = Effect.runSync(Deferred.make<Response>());

  transport = async () => {
    requests += 1;

    if (requests === 1) {
      return Effect.runPromise(Deferred.await(firstResponse));
    }

    return Response.json({ status: "ok" });
  };

  render(Root);

  expect(screen.getByRole("status").textContent).toContain("Checking backend");

  Effect.runSync(Deferred.succeed(firstResponse, Response.json({ status: "ok" })));

  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain("Backend connected (ok)"),
  );
  expect(requests).toBe(1);

  const user = userEvent.setup();

  await user.click(screen.getByRole("button", { name: "Run manual health check" }));
  await screen.findByText("Manual check succeeded.");

  // Initial query + imperative check + invalidation's active-query refetch.
  expect(requests).toBe(3);

  await user.click(screen.getByRole("checkbox", { name: "Enable health query" }));
  await user.click(screen.getByRole("checkbox", { name: "Enable health query" }));

  // The same key reuses the fresh cache instead of inventing duplicate data.
  expect(requests).toBe(3);
});

it("reactively disables and cancels an empty query, then fetches when enabled", async () => {
  const response = Effect.runSync(Deferred.make<Response>());
  let requests = 0;

  transport = () => {
    requests += 1;

    return Effect.runPromise(Deferred.await(response));
  };

  render(Root);

  const user = userEvent.setup();

  await user.click(screen.getByRole("checkbox", { name: "Enable health query" }));
  await screen.findByText("No health data yet.");

  expect(requests).toBe(1);

  await user.click(screen.getByRole("checkbox", { name: "Enable health query" }));
  await waitFor(() => expect(requests).toBe(2));

  Effect.runSync(Deferred.succeed(response, Response.json({ status: "ok" })));

  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain("Backend connected (ok)"),
  );
});

it("shows query and mutation failures without exposing infrastructure details", async () => {
  transport = async () => Response.json({ status: "invalid" });

  render(Root);

  await screen.findByText("Backend unavailable. Please try again.", {}, { timeout: 4000 });

  const user = userEvent.setup();

  await user.click(screen.getByRole("button", { name: "Run manual health check" }));

  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Manual check failed. Please try again.",
  );
});
