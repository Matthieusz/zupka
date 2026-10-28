import { QueryClient } from "@tanstack/svelte-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vite-plus/test";
import { AdminEntry, SaveEntry, PublicationTransition, EntryError } from "@zupka/contracts";
import { Schema } from "effect";
import AppHarness from "./testing/AppHarness.svelte";
import {
  authResponse,
  contentTypes,
  entryPage,
  exampleEntry,
  ownerSession,
} from "./testing/admin-fixtures.js";

let transport: typeof fetch = async () => Response.error();

beforeAll(() => vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) => transport(...args)));

afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  history.replaceState(null, "", "/");
});

function start() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  render(AppHarness, { cache });

  return { cache, user: userEvent.setup() };
}

function path(input: RequestInfo | URL) {
  return new URL(input instanceof Request ? input.url : String(input), location.origin).pathname;
}

it("creates a draft, publishes only saved input, saves isolated changes, unpublishes and confirms permanent deletion", async () => {
  let saved: typeof AdminEntry.Type | null = null;
  const writes: Array<{ method: string; url: string; body: Schema.Json }> = [];

  function savedEntry() {
    return saved;
  }

  transport = async (input, init) => {
    const url = path(input);

    if (url.endsWith("/getSession")) return authResponse(ownerSession());

    if (url.endsWith("/content-types")) return Response.json(contentTypes);

    if (!init?.method || init.method === "GET")
      return Response.json(entryPage(saved ? [saved] : []));
    expect(new Headers(init.headers).get("x-effect-auth-csrf")).toBe("1");
    const body = Schema.decodeUnknownSync(Schema.Json)(await new Response(init.body).json());
    writes.push({ method: init.method, url, body });

    if (init.method === "DELETE") {
      const id = saved?.id;
      saved = null;

      return Response.json({ deleted: id });
    }

    if (!saved)
      saved = Schema.decodeUnknownSync(AdminEntry)({ ...exampleEntry("Created"), draft: body });
    else {
      expect(Schema.decodeUnknownSync(PublicationTransition)(body).revision).toBe(saved.revision);

      if (url.endsWith("/publish"))
        saved = {
          ...saved,
          firstPublishedAt: saved.updatedAt,
          published: { content: saved.draft, publishedAt: saved.updatedAt },
          state: "published",
        };
      else if (url.endsWith("/unpublish"))
        saved = { ...saved, published: null, state: "unpublished" };
      else
        saved = {
          ...saved,
          draft: Schema.decodeUnknownSync(SaveEntry)(body).content,
          state: saved.published ? "published-with-draft-changes" : "unpublished",
        };
      saved = { ...saved, revision: saved.revision + 1 };
    }

    return Response.json(saved);
  };

  const { user } = start();
  await user.click(await screen.findByRole("button", { name: "New entry" }));
  await user.type(screen.getByRole("textbox", { name: "Title" }), "First post");
  await user.tab();
  expect(screen.getByRole("textbox", { name: "Slug" })).toHaveProperty("value", "first-post");
  expect(screen.getByRole("button", { name: "Publish" })).toHaveProperty("disabled", true);
  await user.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByText("Draft saved. Saving does not publish.");
  await user.click(screen.getByRole("button", { name: "Publish" }));
  await screen.findByText("Published. The saved draft is now public.");
  expect(screen.getByRole("textbox", { name: "Slug" })).toHaveProperty("readOnly", true);
  expect(screen.getByRole("button", { name: "Delete entry" })).toHaveProperty("disabled", true);
  await user.type(screen.getByRole("textbox", { name: "Title" }), " edited");
  expect(screen.getByRole("button", { name: "Publish" })).toHaveProperty("disabled", true);
  await user.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByText("Published with draft changes");
  expect(savedEntry()?.published?.content.title).toBe("First post");
  await user.click(screen.getByRole("button", { name: "Unpublish" }));
  await screen.findByText("Unpublished. The working draft is retained.");
  expect(screen.getByRole("textbox", { name: "Slug" })).toHaveProperty("readOnly", true);
  const confirmations: string[] = [];
  vi.stubGlobal("confirm", (message: string) => {
    confirmations.push(message);

    return false;
  });
  await user.click(screen.getByRole("button", { name: "Delete entry" }));
  expect(writes.filter((write) => write.method === "DELETE")).toHaveLength(0);
  vi.stubGlobal("confirm", () => true);
  await user.click(screen.getByRole("button", { name: "Delete entry" }));
  await screen.findByRole("heading", { name: "No entries yet" });
  expect(confirmations[0]).toContain("cannot be undone");
  expect(writes.map((write) => write.method)).toEqual(["POST", "POST", "PUT", "POST", "DELETE"]);
});

it("preserves input on stale/network/validation failures and never silently rebases a conflict", async () => {
  let mode = "stale";
  let writes = 0;
  transport = async (input, init) => {
    const url = path(input);

    if (url.endsWith("/getSession")) return authResponse(ownerSession());

    if (url.endsWith("/content-types")) return Response.json(contentTypes);

    if (init?.method === "PUT") {
      writes += 1;

      if (mode === "network") return Response.error();

      return Response.json(new EntryError({ reason: "stale-revision" }), { status: 409 });
    }

    if (url.endsWith("000000000001"))
      return Response.json({ ...exampleEntry("Other tab"), revision: 3 });

    return Response.json(entryPage([exampleEntry("Original")]));
  };

  const { user } = start();
  await user.click(await screen.findByRole("button", { name: "Original" }));
  await user.clear(screen.getByRole("textbox", { name: "Title" }));
  await user.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByText("Enter a title.");
  expect(writes).toBe(0);
  await user.type(screen.getByRole("textbox", { name: "Title" }), "Local work");
  mode = "network";
  await user.click(screen.getByRole("button", { name: "Save draft" }));
  const feedback = await screen.findByText(/request could not be confirmed/);
  expect(feedback.getAttribute("role")).toBe("alert");
  expect(feedback.classList.contains("sr-only")).toBe(false);
  expect(document.activeElement).toBe(feedback);
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty("value", "Local work");
  mode = "stale";
  await user.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByText(/This entry changed elsewhere/);
  expect(screen.getByRole("button", { name: "Save draft" })).toHaveProperty("disabled", true);
  await user.click(screen.getByRole("button", { name: "Load latest saved version" }));
  await screen.findByRole("heading", { name: "Latest saved version · revision 3" });
  expect(screen.getByRole("textbox", { name: "Title", hidden: true })).toHaveProperty(
    "value",
    "Local work",
  );
  vi.stubGlobal("confirm", () => true);
  await user.click(screen.getByRole("button", { name: "Discard local input and use latest" }));
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty("value", "Other tab");
  expect(writes).toBe(2);
});

it("retains the mounted editor across confirmed session loss while removing protected query data", async () => {
  let active = true;
  transport = async (input) => {
    const url = path(input);

    if (url.endsWith("/getSession")) return authResponse(active ? ownerSession() : null);

    if (url.endsWith("/content-types")) return Response.json(contentTypes);

    return Response.json(entryPage([exampleEntry("Original")]));
  };

  const { cache, user } = start();
  await user.click(await screen.findByRole("button", { name: "Original" }));
  const title = screen.getByRole("textbox", { name: "Title" });
  await user.type(title, " unsaved");
  active = false;
  await cache.invalidateQueries({ queryKey: ["owner-session"] });
  await screen.findByRole("heading", { name: "Owner sign in" });
  expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
  expect(title.isConnected).toBe(true);
  expect(title).toHaveProperty("value", "Original unsaved");
  expect(cache.getQueryCache().findAll({ queryKey: ["admin"] })).toHaveLength(0);
  active = true;
  await cache.invalidateQueries({ queryKey: ["owner-session"] });
  await screen.findByRole("heading", { name: "Edit entry" });
  expect(screen.getByRole("textbox", { name: "Title" })).toBe(title);
  expect(title).toHaveProperty("value", "Original unsaved");
});

it("adds optional fields on demand, preserves omitted local values, and saves only included fields", async () => {
  let saved: typeof AdminEntry.Type | null = null;

  function savedEntry() {
    return saved;
  }

  const types = [
    {
      id: "posts",
      label: "Posts",
      fields: [
        { id: "body", label: "Body", kind: "markdown", required: false },
        { id: "summary", label: "Summary", kind: "text", required: false },
        { id: "venue", label: "Venue", kind: "text", required: true },
      ],
    },
  ];

  transport = async (input, init) => {
    const url = path(input);

    if (url.endsWith("/getSession")) return authResponse(ownerSession());

    if (url.endsWith("/content-types")) return Response.json(types);

    if (init?.method === "POST") {
      const draft: unknown = await new Response(init.body).json();
      saved = Schema.decodeUnknownSync(AdminEntry)({ ...exampleEntry("Writing"), draft });

      return Response.json(saved);
    }

    return Response.json(entryPage([]));
  };

  const { user } = start();
  await user.click(await screen.findByRole("button", { name: "New entry" }));
  expect(screen.queryByRole("textbox", { name: "Summary" })).toBeNull();
  expect(screen.getByRole("textbox", { name: "Body" })).toHaveProperty("disabled", false);
  await user.type(screen.getByRole("textbox", { name: "Title" }), "Writing");
  await user.type(screen.getByRole("textbox", { name: "Body" }), "A working draft");
  expect(screen.getByRole("button", { name: "Preview Markdown" })).toHaveProperty(
    "disabled",
    false,
  );
  await user.click(screen.getByRole("button", { name: "Omit Body" }));
  expect(screen.getByRole("textbox", { name: "Body" })).toHaveProperty("value", "");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add Body" }));
  await user.click(screen.getByRole("button", { name: "Add Body" }));
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Body" }));
  expect(screen.getByRole("textbox", { name: "Body" })).toHaveProperty("value", "A working draft");
  await user.click(screen.getByRole("button", { name: "Add Summary" }));
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Summary" }));
  await user.type(screen.getByRole("textbox", { name: "Summary" }), "Keep locally");
  await user.click(screen.getByRole("button", { name: "Omit Summary" }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add Summary" }));
  await user.click(screen.getByRole("button", { name: "Add Summary" }));
  expect(screen.getByRole("textbox", { name: "Summary" })).toHaveProperty("value", "Keep locally");
  await user.click(screen.getByRole("button", { name: "Omit Summary" }));
  await user.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByText("Draft saved. Saving does not publish.");
  expect(savedEntry()?.draft.fields).toEqual({ body: "A working draft" });
  await user.click(screen.getByRole("button", { name: "Publish" }));
  await screen.findByText("Required for publication.");
  expect(screen.queryByRole("textbox", { name: "Venue" })).toBeNull();
  expect(screen.getByRole("button", { name: "Add Venue" })).toHaveProperty("disabled", false);
});

it("warns before discarding authored input and preserves it when navigation is cancelled", async () => {
  transport = async (input) =>
    path(input).endsWith("/getSession")
      ? authResponse(ownerSession())
      : path(input).endsWith("/content-types")
        ? Response.json(contentTypes)
        : Response.json(entryPage([]));
  const { user } = start();
  await user.click(await screen.findByRole("button", { name: "New entry" }));
  await user.type(screen.getByRole("textbox", { name: "Title" }), "Unsaved");
  await user.click(screen.getByRole("link", { name: "Skip to content" }));
  expect(location.hash).toBe("");
  expect(document.activeElement).toBe(screen.getByRole("main"));
  vi.stubGlobal("confirm", () => false);
  await user.click(screen.getByRole("button", { name: "Back to Posts" }));
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty("value", "Unsaved");
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  vi.stubGlobal("confirm", () => true);
  await user.click(screen.getByRole("button", { name: "Back to Posts" }));
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull());
});

it("compares saved snapshots from the header without showing or losing unsaved editor input", async () => {
  const entry = exampleEntry("Saved title", "published-with-draft-changes");
  transport = async (input) => {
    const url = path(input);

    if (url.endsWith("/getSession")) return authResponse(ownerSession());

    if (url.endsWith("/content-types")) return Response.json(contentTypes);

    return Response.json(entryPage([entry]));
  };

  const { user } = start();
  await user.click(await screen.findByRole("button", { name: "Saved title" }));
  const title = screen.getByRole("textbox", { name: "Title" });
  await user.type(title, " unsaved");
  await user.click(screen.getByRole("button", { name: /^Versions/ }));
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { name: "Saved draft and published version" }),
  );
  const draft = within(screen.getByRole("article", { name: "Saved draft snapshot" }));
  const published = within(screen.getByRole("article", { name: "Published version snapshot" }));
  expect(draft.getByRole("heading", { name: "Saved title" })).toBeTruthy();
  expect(published.getByRole("heading", { name: "Previous public title" })).toBeTruthy();
  expect(draft.getByText("Changed")).toBeTruthy();
  expect(screen.getByText("1 field differs from the published version.")).toBeTruthy();
  expect(screen.getByText("You also have unsaved changes in the editor.")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Close versions" }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Versions/ }));
  expect(screen.getByRole("textbox", { name: "Title" })).toBe(title);
  expect(title).toHaveProperty("value", "Saved title unsaved");
});

it.each(["Control", "Meta"])(
  "supports %s editor shortcuts without bypassing publication or dialog guards",
  async (modifier) => {
    let saved: typeof AdminEntry.Type | null = null;
    const writes: string[] = [];
    transport = async (input, init) => {
      const url = path(input);

      if (url.endsWith("/getSession")) return authResponse(ownerSession());

      if (url.endsWith("/content-types"))
        return Response.json([
          {
            ...contentTypes[0],
            fields: [
              { id: "body", label: "Body", kind: "markdown", required: false },
              { id: "notes", label: "Notes", kind: "markdown", required: false },
            ],
          },
        ]);

      if (init?.method === "POST") {
        writes.push(url);

        if (saved)
          saved = {
            ...saved,
            state: "published",
            published: { content: saved.draft, publishedAt: saved.updatedAt },
          };
        else
          saved = Schema.decodeUnknownSync(AdminEntry)({
            ...exampleEntry("Shortcut draft"),
            draft: await new Response(init.body).json(),
          });

        return Response.json(saved);
      }

      return Response.json(entryPage(saved ? [saved] : []));
    };

    const { user } = start();
    const shortcut = async (keys: string) => user.keyboard(`{${modifier}>}${keys}{/${modifier}}`);
    await user.click(await screen.findByRole("button", { name: "New entry" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Shortcut draft");
    await shortcut("{Enter}");
    expect(writes).toHaveLength(0);
    await shortcut("s");
    const announcement = await screen.findByText("Draft saved. Saving does not publish.");
    expect(announcement.classList.contains("sr-only")).toBe(true);
    expect(announcement.getAttribute("role")).toBe("status");
    expect(document.getElementById("editor-feedback")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Title" }));
    expect(screen.getByRole("textbox", { name: "Slug" })).toHaveProperty("value", "shortcut-draft");
    await shortcut("{Enter}");
    await screen.findByText("Published. The saved draft is now public.");
    expect(writes).toHaveLength(2);

    const notes = screen.getByRole("textbox", { name: "Notes" });
    await user.type(notes, "# Focused field");
    await shortcut("{Shift>}p{/Shift}");
    expect(screen.getByRole("region", { name: "Notes preview" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Body preview" })).toBeNull();
    await shortcut("{Enter}");
    expect(writes).toHaveLength(2);
    await shortcut("{Shift>}p{/Shift}");
    expect(screen.queryByRole("region", { name: "Notes preview" })).toBeNull();
    await shortcut("{Shift>}i{/Shift}");
    const dialog = await screen.findByRole("dialog");
    await shortcut("s");
    await shortcut("{Enter}");
    expect(writes).toHaveLength(2);
    expect(dialog.isConnected).toBe(true);
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(
      screen.getAllByRole("button", { name: "Insert managed image" })[1],
    );
    expect(notes).toHaveProperty("value", "# Focused field");
  },
);

it("ignores repeated, composing and Alt-modified save shortcuts", async () => {
  let writes = 0;
  transport = async (input, init) => {
    if (path(input).endsWith("/getSession")) return authResponse(ownerSession());

    if (path(input).endsWith("/content-types")) return Response.json(contentTypes);

    if (init?.method === "POST") writes += 1;

    return Response.json(entryPage([]));
  };

  const { user } = start();
  await user.click(await screen.findByRole("button", { name: "New entry" }));
  const title = screen.getByRole("textbox", { name: "Title" });
  await user.type(title, "Keep writing");

  for (const extra of [{ repeat: true }, { isComposing: true }, { altKey: true }])
    await fireEvent.keyDown(title, { key: "s", ctrlKey: true, ...extra });
  expect(writes).toBe(0);
});

it("updates the safe Markdown preview while writing and preserves source through view changes and omission", async () => {
  transport = async (input) => {
    const url = path(input);

    if (url.endsWith("/getSession")) return authResponse(ownerSession());

    if (url.endsWith("/content-types"))
      return Response.json([
        {
          ...contentTypes[0],
          fields: [{ id: "body", label: "Body", kind: "markdown", required: false }],
        },
      ]);

    return Response.json(entryPage([]));
  };

  const { user } = start();
  await user.click(await screen.findByRole("button", { name: "New entry" }));
  const body = screen.getByRole("textbox", { name: "Body" });
  await user.type(body, "# First heading");
  await user.click(screen.getByRole("button", { name: "Preview Markdown" }));
  expect(screen.getByRole("heading", { name: "First heading" })).toBeTruthy();
  await user.type(body, " revised");
  expect(screen.getByRole("heading", { name: "First heading revised" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Write" }));
  await user.click(screen.getByRole("button", { name: "Preview" }));
  expect(body).toHaveProperty("value", "# First heading revised");
  await user.click(screen.getByRole("button", { name: "Hide preview" }));
  expect(screen.queryByRole("region", { name: "Body preview" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Omit Body" }));
  await user.click(screen.getByRole("button", { name: "Add Body" }));
  expect(body).toHaveProperty("value", "# First heading revised");
});
