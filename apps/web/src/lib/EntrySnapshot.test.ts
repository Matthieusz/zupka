import { render, screen } from "@testing-library/svelte";
import { expect, it } from "vite-plus/test";
import { AdminEntry } from "@zupka/contracts";
import { ContentTypeDefinition } from "@zupka/shared";
import { Schema } from "effect";
import { exampleEntry } from "../testing/admin-fixtures.js";
import EntrySnapshot from "./EntrySnapshot.svelte";

it("renders configured snapshot values without losing false, zero, empty, or omitted distinctions", () => {
  const type = Schema.decodeUnknownSync(ContentTypeDefinition)({
    id: "posts",
    label: "Posts",
    fields: [
      { id: "count", label: "Count", kind: "number", required: false },
      { id: "featured", label: "Featured", kind: "boolean", required: false },
      { id: "tags", label: "Tags", kind: "text-list", required: false },
      { id: "summary", label: "Summary", kind: "text", required: false },
      { id: "body", label: "Body", kind: "markdown", required: false },
      { id: "cover", label: "Cover", kind: "image", required: false },
    ],
  });

  const entry = Schema.decodeUnknownSync(AdminEntry)({
    ...exampleEntry("Snapshot"),
    draft: {
      title: "Snapshot",
      slug: "snapshot",
      fields: {
        count: 0,
        featured: false,
        tags: ["", "Design"],
        summary: "",
        cover: { imageId: "00000000-0000-4000-8000-000000000002", alt: "Managed cover" },
      },
    },
  });

  render(EntrySnapshot, { type, content: entry.draft, changed: ["featured", "body"] });
  expect(screen.getByText("0")).toBeTruthy();
  expect(screen.getByText("False")).toBeTruthy();
  expect(screen.getByText("(empty item)")).toBeTruthy();
  expect(screen.getByText("(empty)")).toBeTruthy();
  expect(screen.getByText("Not included")).toBeTruthy();
  expect(screen.getAllByText("Changed")).toHaveLength(2);
  expect(screen.getByRole("img", { name: "Managed cover" }).getAttribute("src")).toBe(
    "/api/images/00000000-0000-4000-8000-000000000002",
  );
});
