import { QueryClient, focusManager } from "@tanstack/svelte-query";
import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { Deferred, Effect } from "effect";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vite-plus/test";
import AppHarness from "./testing/AppHarness.svelte";
import {
  authResponse,
  contentTypes,
  entryPage,
  exampleEntry,
  ownerSession,
} from "./testing/admin-fixtures.js";

let transport: typeof globalThis.fetch = async () => Response.error();

beforeAll(() => {
  const fetch: typeof globalThis.fetch = (...args) => transport(...args);
  vi.stubGlobal("fetch", fetch);
});

afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  history.replaceState(null, "", "/");
  focusManager.setFocused(true);
});

function start() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 }, mutations: { retry: false } },
  });

  render(AppHarness, { cache });

  return cache;
}

function urlOf(input: RequestInfo | URL) {
  return new URL(input instanceof Request ? input.url : String(input), location.origin);
}

function authenticated(input: RequestInfo | URL) {
  const url = urlOf(input);

  if (url.pathname.endsWith("/getSession")) return authResponse(ownerSession());

  if (url.pathname.endsWith("/content-types")) return Response.json(contentTypes);

  return null;
}

it("keeps management requests behind sign-in and removes scaffold interactions", async () => {
  const urls: string[] = [];
  transport = async (input) => {
    urls.push(urlOf(input).pathname);

    return authResponse(null);
  };

  start();
  await screen.findByRole("heading", { name: "Owner sign in" });
  expect(urls).toEqual(["/api/auth/getSession"]);
  expect(screen.queryByRole("navigation", { name: "Content types" })).toBeNull();
  expect(screen.queryByText("Zupka scaffold")).toBeNull();
  expect(screen.queryByRole("button", { name: "Run manual health check" })).toBeNull();
});

it("applies publication filters immediately and resets pagination without a title search", async () => {
  const requests: URL[] = [];
  transport = async (input) => {
    const response = authenticated(input);

    if (response) return response;
    const url = urlOf(input);
    requests.push(url);
    const offset = Number(url.searchParams.get("offset"));

    return Response.json(
      entryPage(
        [exampleEntry(`${url.pathname.endsWith("notes") ? "Note" : "Post"} page ${offset}`)],
        offset,
        45,
      ),
    );
  };

  const cache = start();
  const user = userEvent.setup();
  await screen.findByRole("heading", { name: "Post page 0" });
  await user.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByRole("heading", { name: "Post page 20" });
  expect(screen.queryByRole("searchbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Publication state" }),
    "published-with-draft-changes",
  );
  await waitFor(() =>
    expect(requests.at(-1)?.searchParams.get("state")).toBe("published-with-draft-changes"),
  );
  expect(requests.at(-1)?.searchParams.get("offset")).toBe("0");
  expect(requests.every((url) => url.searchParams.get("limit") === "20")).toBe(true);
  expect(
    cache.getQueryData(["admin", "entries", "posts", "", "published-with-draft-changes", 20, 0]),
  ).toBeDefined();
  await user.click(screen.getByRole("link", { name: "Field notes" }));
  await screen.findByRole("heading", { name: "Note page 0" });
  expect(screen.getByRole("link", { name: "Field notes" }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Field notes" }));
  expect(screen.getByRole("combobox", { name: "Publication state" })).toHaveProperty(
    "value",
    "all",
  );
  expect(requests.at(-1)?.searchParams.get("state")).toBeNull();
  await user.click(screen.getByRole("link", { name: "Posts" }));
  await screen.findByRole("heading", { name: "Post page 0" });
  // A fresh, parameter-identical first page is reused, not fetched under a new ad-hoc key.
  expect(
    requests.filter(
      (url) =>
        url.pathname.endsWith("posts") &&
        url.searchParams.get("search") === "" &&
        url.searchParams.get("offset") === "0" &&
        !url.searchParams.has("state"),
    ),
  ).toHaveLength(1);
});

it("searches content with Ctrl K and opens a result using the keyboard", async () => {
  const requests: URL[] = [];
  transport = async (input) => {
    const auth = authenticated(input);

    if (auth) return auth;
    const url = urlOf(input);
    requests.push(url);

    return Response.json(
      entryPage(
        url.searchParams.get("search") === "needle"
          ? url.pathname.endsWith("posts")
            ? [exampleEntry("Needle entry")]
            : []
          : [exampleEntry("Searchable entry")],
      ),
    );
  };

  start();
  await screen.findByRole("heading", { name: "Searchable entry" });
  const user = userEvent.setup();
  await user.keyboard("{Control>}k{/Control}");
  await screen.findByRole("dialog", { name: "Search content" });
  const input = screen.getByRole("combobox", { name: "Search entries" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  await user.type(input, "needle");
  await screen.findByRole("option", { name: /Needle entry/ });
  expect(
    requests.flatMap((url) =>
      url.searchParams.get("search") === "needle" ? [url.pathname.split("/").at(-1)] : [],
    ),
  ).toEqual(["posts", "projects", "notes"]);
  await user.keyboard("{ArrowDown}{Enter}");
  await screen.findByRole("heading", { name: "Edit entry" });
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty("value", "Needle entry");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("opens search from its trigger, recovers from failures and empty results, and closes with Escape", async () => {
  let fail = true;
  transport = async (input) => {
    const auth = authenticated(input);

    if (auth) return auth;

    if (urlOf(input).searchParams.get("search"))
      return fail ? Response.error() : Response.json(entryPage([]));

    return Response.json(entryPage([]));
  };

  start();
  const trigger = await screen.findByRole("button", { name: /Search your content/ });
  const user = userEvent.setup();
  await user.click(trigger);
  const input = await screen.findByRole("combobox", { name: "Search entries" });
  await user.type(input, "missing");
  await screen.findByText("Unable to search. Check your connection and try again.");
  fail = false;
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText("No matching entries.");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  await user.keyboard("{Meta>}k{/Meta}");
  await screen.findByRole("dialog", { name: "Search content" });
  expect(screen.getByRole("combobox", { name: "Search entries" })).toHaveProperty("value", "");
});

it("shows full long titles, safe text, dates, and all three publication states", async () => {
  const longTitle = "A title ".repeat(40).trimEnd();
  const safeTitle = "<script>not executable</script>";
  transport = async (input) =>
    authenticated(input) ??
    Response.json(
      entryPage([
        exampleEntry(longTitle),
        exampleEntry(
          safeTitle,
          "published-with-draft-changes",
          "00000000-0000-4000-8000-000000000002",
        ),
        exampleEntry("Public entry", "published", "00000000-0000-4000-8000-000000000003"),
      ]),
    );
  start();
  await screen.findByRole("heading", { name: safeTitle });
  expect(screen.getByRole("heading", { name: longTitle })).toBeDefined();
  expect(screen.getByText("Unpublished", { selector: "p" })).toBeDefined();
  expect(screen.getByText("Published with draft changes", { selector: "p" })).toBeDefined();
  expect(screen.getByText("Published", { selector: "p" })).toBeDefined();
  expect(document.querySelectorAll("time")).toHaveLength(3);
  expect(document.querySelector("main script")).toBeNull();
});

it("covers loading, failure without retries, preserved filters, empty results and recovery", async () => {
  const response = Deferred.makeUnsafe<Response>();
  let mode = "pending";
  let requests = 0;
  transport = async (input) => {
    const auth = authenticated(input);

    if (auth) return auth;
    requests += 1;

    if (mode === "pending") return Effect.runPromise(Deferred.await(response));

    if (mode === "error") return Response.error();

    return Response.json(entryPage(mode === "empty" ? [] : [exampleEntry("Recovered entry")]));
  };

  start();
  await screen.findByText("Loading entries…");
  mode = "error";
  Effect.runSync(Deferred.succeed(response, Response.error()));
  await screen.findByRole("heading", { name: "Unable to load entries" });
  expect(requests).toBe(1);
  const user = userEvent.setup();
  mode = "empty";
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Publication state" }),
    "published",
  );
  await screen.findByRole("heading", { name: "No matching entries" });
  expect(screen.getByRole("combobox", { name: "Publication state" })).toHaveProperty(
    "value",
    "published",
  );
  mode = "success";
  await user.click(screen.getByRole("button", { name: "Show all entries" }));
  await screen.findByRole("heading", { name: "Recovered entry" });
});

it("treats uncontracted 401 management responses as session loss and clears every protected query", async () => {
  let deny = false;
  transport = async (input) =>
    authenticated(input) ??
    (deny
      ? Response.json({ error: "Authentication required" }, { status: 401 })
      : Response.json(entryPage([exampleEntry("Private entry")])));
  const cache = start();
  await screen.findByRole("heading", { name: "Private entry" });
  deny = true;
  const user = userEvent.setup();
  await user.click(screen.getByRole("link", { name: "Projects" }));
  await screen.findByText("Your session ended. Sign in again to continue.");
  await waitFor(() =>
    expect(cache.getQueryCache().findAll({ queryKey: ["admin"] })).toHaveLength(0),
  );
  expect(screen.queryByText("Private entry")).toBeNull();
  expect(screen.queryByRole("navigation", { name: "Content types" })).toBeNull();
});

it("cancels in-flight private reads on session loss and never resurrects their late results", async () => {
  const response = Deferred.makeUnsafe<Response>();
  let active = true;
  const started = Deferred.makeUnsafe<AbortSignal>();
  transport = async (input, init) => {
    const url = urlOf(input);

    if (url.pathname.endsWith("/getSession")) return authResponse(active ? ownerSession() : null);

    if (url.pathname.endsWith("/content-types")) return Response.json(contentTypes);
    const signal = init?.signal;

    if (!signal) throw new Error("Missing request cancellation signal");
    Effect.runSync(Deferred.succeed(started, signal));

    return Effect.runPromise(Deferred.await(response));
  };

  const cache = start();
  await screen.findByText("Loading entries…");
  active = false;
  await cache.invalidateQueries({ queryKey: ["owner-session"] });
  await screen.findByText("Your session ended. Sign in again to continue.");
  expect((await Effect.runPromise(Deferred.await(started))).aborted).toBe(true);
  Effect.runSync(
    Deferred.succeed(response, Response.json(entryPage([exampleEntry("Late private entry")]))),
  );
  await waitFor(() =>
    expect(cache.getQueryCache().findAll({ queryKey: ["admin"] })).toHaveLength(0),
  );
  expect(screen.queryByText("Late private entry")).toBeNull();
});

it("keeps sign-out failures actionable, then revokes UI and cached data after successful sign-out", async () => {
  let fail = true;
  let attempts = 0;
  transport = async (input) => {
    if (urlOf(input).pathname.endsWith("/signOut")) {
      attempts += 1;

      return fail
        ? Response.error()
        : authResponse({ clearCredential: true, invalidation: "revoked" });
    }

    return authenticated(input) ?? Response.json(entryPage([exampleEntry("Private entry")]));
  };

  const cache = start();
  await screen.findByRole("heading", { name: "Private entry" });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByText("Sign out failed. Please try again.");
  expect(attempts).toBe(1);
  expect(screen.getByRole("heading", { name: "Private entry" })).toBeDefined();
  fail = false;
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByRole("heading", { name: "Owner sign in" });
  expect(cache.getQueryCache().findAll({ queryKey: ["admin"] })).toHaveLength(0);
  expect(screen.queryByText("Private entry")).toBeNull();
  expect(screen.queryByText("Your session ended. Sign in again to continue.")).toBeNull();
});

it("handles unknown navigation and makes the skip link work without changing content type", async () => {
  history.replaceState(null, "", "/#/content/missing");
  transport = async (input) => authenticated(input) ?? Response.json(entryPage([]));
  start();
  await screen.findByRole("heading", { name: "Content type not found" });
  const user = userEvent.setup();
  await user.click(screen.getByRole("link", { name: "Projects" }));
  await screen.findByRole("heading", { name: "No entries yet" });
  await user.click(screen.getByRole("link", { name: "Skip to content" }));
  expect(screen.getByRole("heading", { name: "Projects" })).toBeDefined();
  expect(screen.queryByRole("heading", { name: "Content type not found" })).toBeNull();
});

it("rejects malformed content definitions rather than trusting their labels or showing private list data", async () => {
  let lists = 0;
  transport = async (input) => {
    if (urlOf(input).pathname.endsWith("/getSession")) return authResponse(ownerSession());

    if (urlOf(input).pathname.endsWith("/content-types"))
      return Response.json([{ id: "../unsafe", label: "Injected type", fields: [] }]);
    lists += 1;

    return Response.error();
  };

  start();
  await screen.findByText("Unable to load content types. Check your connection and try again.");
  expect(screen.queryByText("Injected type")).toBeNull();
  expect(lists).toBe(0);
});
