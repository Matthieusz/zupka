import { QueryClient } from "@tanstack/svelte-query";
import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vite-plus/test";
import { ImageInUse, ManagedImage } from "@zupka/contracts";
import { EntryId } from "@zupka/shared";
import { Schema } from "effect";
import AppHarness from "./testing/AppHarness.svelte";
import { authResponse, ownerSession, entryPage } from "./testing/admin-fixtures.js";

let transport: typeof fetch = async () => Response.error();

beforeAll(() => vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) => transport(...args)));

afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  history.replaceState(null, "", "/");
});

const image = Schema.decodeUnknownSync(ManagedImage)({
  id: "00000000-0000-4000-8000-000000000001",
  mediaType: "image/png",
  bytes: 100,
  width: 24,
  height: 24,
  createdAt: "2026-10-14T12:00:00.000Z",
  state: "active",
  url: "/api/images/00000000-0000-4000-8000-000000000001",
});

const types = [
  {
    id: "posts",
    label: "Posts",
    fields: [
      { id: "body", label: "Body", kind: "markdown", required: false },
      { id: "cover", label: "Cover", kind: "image", required: false },
    ],
  },
];

function initial(input: RequestInfo | URL) {
  const url = new URL(input instanceof Request ? input.url : String(input), location.origin);

  if (url.pathname.endsWith("/getSession")) return authResponse(ownerSession());

  if (url.pathname.endsWith("/content-types")) return Response.json(types);

  if (url.pathname.endsWith("/entries/posts")) return Response.json(entryPage([]));

  return null;
}

function start() {
  render(AppHarness, {
    cache: new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    }),
  });

  return userEvent.setup();
}

it("inserts managed images with snapshot-owned alt text into image and Markdown fields", async () => {
  transport = async (input) =>
    initial(input) ?? Response.json({ items: [image], total: 1, offset: 0, limit: 20 });
  const user = start();
  await user.click(await screen.findByRole("button", { name: "New entry" }));
  await user.click(screen.getByRole("button", { name: "Add Cover" }));
  await user.click(screen.getByRole("button", { name: "Choose Cover" }));
  await user.click(await screen.findByRole("button", { name: /Select image 1/ }));
  await user.type(
    await screen.findByRole("textbox", { name: "Alt text for selected image" }),
    "Cover description",
  );
  await user.click(screen.getByRole("button", { name: "Choose image" }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Replace image" }));
  expect(screen.getByRole("img", { name: "Cover description" }).getAttribute("src")).toBe(
    image.url,
  );
  await user.click(screen.getByRole("button", { name: "Insert managed image" }));
  await user.click(await screen.findByRole("button", { name: /Select image 1/ }));
  await user.type(
    await screen.findByRole("textbox", { name: "Alt text for selected image" }),
    "A caption",
  );
  await user.click(screen.getByRole("button", { name: "Insert image" }));
  expect(screen.getByRole("textbox", { name: "Body" })).toHaveProperty(
    "value",
    `\n![A caption](${image.url})\n`,
  );
  await user.click(screen.getByRole("button", { name: "Preview Markdown" }));
  expect(screen.getByRole("img", { name: "A caption" }).getAttribute("src")).toBe(image.url);
});

it("confirms image deletion, displays actionable reference conflicts, and paginates with complete query keys", async () => {
  history.replaceState(null, "", "/#/images");
  let deletes = 0;
  const offsets: number[] = [];
  transport = async (input, init) => {
    const response = initial(input);

    if (response) return response;

    if (init?.method === "DELETE") {
      deletes += 1;
      expect(new Headers(init.headers).get("x-effect-auth-csrf")).toBe("1");

      return Response.json(
        new ImageInUse({
          references: [{ entryId: Schema.decodeSync(EntryId)(image.id), kind: "draft" }],
        }),
        { status: 409 },
      );
    }

    const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
    const offset = Number(url.searchParams.get("offset"));
    offsets.push(offset);

    return Response.json({ items: [image], total: 21, offset, limit: 20 });
  };

  const user = start();
  await screen.findByRole("button", { name: "Delete image" });
  vi.stubGlobal("confirm", () => false);
  await user.click(screen.getByRole("button", { name: "Delete image" }));
  expect(deletes).toBe(0);
  vi.stubGlobal("confirm", () => true);
  await user.click(screen.getByRole("button", { name: "Delete image" }));
  await screen.findByText(/Remove those references and save or republish each entry/);
  expect(deletes).toBe(1);
  await user.click(screen.getByRole("button", { name: "Next images" }));
  await waitFor(() => expect(offsets).toEqual([0, 20]));
});

it("cancels the modal without including an omitted field or changing entry input and restores trigger focus", async () => {
  transport = async (input) =>
    initial(input) ?? Response.json({ items: [image], total: 1, offset: 0, limit: 20 });
  const user = start();
  await user.click(await screen.findByRole("button", { name: "New entry" }));
  const trigger = screen.getByRole("button", { name: "Insert managed image" });
  await user.click(trigger);
  await screen.findByRole("dialog", { name: "Insert image" });
  expect(screen.queryByRole("button", { name: "Delete image" })).toBeNull();
  await user.click(await screen.findByRole("button", { name: /Select image 1/ }));
  await user.type(
    screen.getByRole("textbox", { name: "Alt text for selected image" }),
    "Do not insert",
  );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
  expect(screen.getByRole("button", { name: "Add Body" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Body" })).toHaveProperty("value", "");
  expect(screen.getByText("Not saved")).toBeTruthy();
});

it("inserts at the remembered selection end without deleting selected writing and supports decorative images", async () => {
  transport = async (input) =>
    initial(input) ?? Response.json({ items: [image], total: 1, offset: 0, limit: 20 });
  const user = start();
  await user.click(await screen.findByRole("button", { name: "New entry" }));
  const body = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Body" });
  await user.type(body, "Before after");
  body.setSelectionRange(0, 6);
  await user.click(screen.getByRole("button", { name: "Insert managed image" }));
  await user.click(await screen.findByRole("button", { name: /Select image 1/ }));
  expect(screen.getByRole("button", { name: "Insert image" })).toHaveProperty("disabled", true);
  await user.click(screen.getByRole("checkbox", { name: "This image is decorative" }));
  await user.click(screen.getByRole("button", { name: "Insert image" }));
  const inserted = `\n![](${image.url})\n`;
  expect(body.value).toBe(`Before${inserted} after`);
  expect(body.selectionStart).toBe(6 + inserted.length);
  expect(body.selectionEnd).toBe(body.selectionStart);
  expect(document.activeElement).toBe(body);
});

it("does not carry an image description onto a different selected image", async () => {
  const second = {
    ...image,
    id: "00000000-0000-4000-8000-000000000002",
    url: "/api/images/00000000-0000-4000-8000-000000000002",
  };

  transport = async (input) =>
    initial(input) ?? Response.json({ items: [image, second], total: 2, offset: 0, limit: 20 });
  const user = start();
  await user.click(await screen.findByRole("button", { name: "New entry" }));
  await user.click(screen.getByRole("button", { name: "Insert managed image" }));
  await user.click(await screen.findByRole("button", { name: /Select image 1/ }));
  await user.type(
    screen.getByRole("textbox", { name: "Alt text for selected image" }),
    "First image only",
  );
  await user.click(screen.getByRole("button", { name: /Select image 2/ }));
  expect(screen.getByRole("textbox", { name: "Alt text for selected image" })).toHaveProperty(
    "value",
    "",
  );
  expect(screen.getByRole("button", { name: "Insert image" })).toHaveProperty("disabled", true);
});

it("selects a successful upload for review without inserting it and keeps it when cancelled", async () => {
  let uploaded = false;
  transport = async (input, init) => {
    const response = initial(input);

    if (response) return response;

    if (init?.method === "POST") {
      uploaded = true;

      return Response.json(image);
    }

    return Response.json({
      items: uploaded ? [image] : [],
      total: uploaded ? 1 : 0,
      offset: 0,
      limit: 20,
    });
  };

  const user = start();
  await user.click(await screen.findByRole("button", { name: "New entry" }));
  await user.click(screen.getByRole("button", { name: "Insert managed image" }));
  await user.click(await screen.findByRole("button", { name: "Upload an image" }));
  const file = new File([new Uint8Array([1])], "test.png", { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(1) });
  await user.upload(screen.getByLabelText("Image file"), file);
  await user.click(screen.getByRole("button", { name: "Upload image" }));
  await screen.findByText(/Uploaded. Review the image before inserting/);
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Alt text for selected image" }),
    ),
  );
  expect(screen.getByRole("textbox", { name: "Alt text for selected image" })).toHaveProperty(
    "value",
    "",
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "Add Body" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Insert managed image" }));
  expect(await screen.findByRole("button", { name: /Select image 1/ })).toBeTruthy();
});

it("retries a failed library page and paginates inside the picker", async () => {
  let unavailable = true;
  const offsets: number[] = [];
  transport = async (input) => {
    const response = initial(input);

    if (response) return response;

    if (unavailable) return Response.error();
    const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
    const offset = Number(url.searchParams.get("offset"));
    offsets.push(offset);

    return Response.json({ items: [image], total: 21, offset, limit: 20 });
  };

  const user = start();
  await user.click(await screen.findByRole("button", { name: "New entry" }));
  await user.click(screen.getByRole("button", { name: "Insert managed image" }));
  await screen.findByText("Unable to load the image library.");
  unavailable = false;
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await user.click(await screen.findByRole("button", { name: "Next images" }));
  await waitFor(() => expect(offsets).toEqual([0, 20]));
  expect(await screen.findByRole("button", { name: /Select image 21/ })).toBeTruthy();
});

it("rejects oversized uploads locally without changing the entry", async () => {
  let writes = 0;
  transport = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.origin);

    if (init?.method === "POST" && url.pathname.endsWith("/admin/images")) writes += 1;

    return initial(input) ?? Response.json({ items: [], total: 0, offset: 0, limit: 20 });
  };

  const user = start();
  await user.click(await screen.findByRole("button", { name: "New entry" }));
  await user.click(screen.getByRole("button", { name: "Insert managed image" }));
  await user.click(await screen.findByRole("button", { name: "Upload an image" }));
  const file = new File(["synthetic"], "large.png", { type: "image/png" });
  Object.defineProperty(file, "size", { value: 10 * 1024 * 1024 + 1 });
  await user.upload(screen.getByLabelText("Image file"), file);
  await user.click(screen.getByRole("button", { name: "Upload image" }));
  await screen.findByText("The image exceeds 10 MiB. Choose a smaller file.");
  expect(writes).toBe(0);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "Add Body" })).toBeTruthy();
});
