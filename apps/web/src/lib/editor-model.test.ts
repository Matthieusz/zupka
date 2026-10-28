import { expect, it } from "vite-plus/test";
import { ContentTypeDefinition } from "@zupka/shared";
import { Schema } from "effect";
import { fieldInputs, parseControls } from "./editor-model.js";
import { exampleEntry } from "../testing/admin-fixtures.js";

const type = Schema.decodeUnknownSync(ContentTypeDefinition)({
  id: "everything",
  label: "Everything",
  fields: [
    { id: "text", label: "Text", kind: "text", required: true },
    { id: "number", label: "Number", kind: "number", required: false, default: 0 },
    { id: "boolean", label: "Boolean", kind: "boolean", required: false, default: false },
    { id: "date", label: "Date", kind: "datetime", required: false },
    { id: "url", label: "URL", kind: "url", required: false },
    { id: "markdown", label: "Markdown", kind: "markdown", required: false },
    { id: "image", label: "Image", kind: "image", required: false },
    { id: "select", label: "Select", kind: "select", required: false, choices: ["One", "Two"] },
    { id: "list", label: "List", kind: "text-list", required: false },
  ],
});

it("round-trips every field kind through shared schemas, preserving false/zero and normalizing dates", () => {
  const inputs = fieldInputs(type, null);

  const values = {
    text: "Words",
    number: "0",
    boolean: "false",
    date: "2026-10-14T12:00:00+02:00",
    url: "https://example.com/",
    markdown: "# Heading",
    image: "00000000-0000-4000-8000-000000000001",
    select: "Two",
    list: "first\nsecond",
  };

  for (const [id, text] of Object.entries(values))
    inputs[id] = {
      enabled: true,
      text,
      alt: id === "image" ? "Description" : "",
      items: id === "list" ? ["first", "second"] : [],
    };

  const parsed = parseControls(type, "Title", "title", inputs, "publish");
  expect(parsed.errors).toEqual({});
  expect(parsed.content?.fields).toEqual({
    ...values,
    number: 0,
    boolean: false,
    date: "2026-10-14T10:00:00.000Z",
    image: { imageId: values.image, alt: "Description" },
    list: ["first", "second"],
  });
  const saved = { ...exampleEntry("Title"), draft: parsed.content ?? exampleEntry("Title").draft };
  expect(fieldInputs(type, saved)).toEqual({
    ...inputs,
    date: { ...inputs.date, text: "2026-10-14T10:00:00.000Z" },
  });
});

it("distinguishes omitted fields from false, empty strings and lists; defaults apply only to new editors", () => {
  const created = fieldInputs(type, null);
  expect(created.number).toMatchObject({ enabled: true, text: "0" });
  expect(created.boolean).toMatchObject({ enabled: true, text: "false" });
  const existing = fieldInputs(type, exampleEntry("Title"));
  expect(existing.number?.enabled).toBe(false);
  expect(parseControls(type, "Title", "title", existing, "draft").content?.fields).toEqual({});
  expect(parseControls(type, "Title", "title", existing, "publish").errors.text).toBe(
    "Required for publication.",
  );
});

it("preserves empty list items and embedded newlines without splitting or dropping content", () => {
  const entry = exampleEntry("Lists");
  const saved = { ...entry, draft: { ...entry.draft, fields: { list: ["", "one\ntwo", ""] } } };
  const inputs = fieldInputs(type, saved);
  expect(
    parseControls(type, saved.draft.title, saved.draft.slug, inputs, "draft").content?.fields.list,
  ).toEqual(["", "one\ntwo", ""]);
});

it("returns field-specific schema errors without mutating malformed raw input", () => {
  const inputs = fieldInputs(type, null);

  for (const [id, text] of Object.entries({
    number: "oops",
    date: "2026-02-30",
    url: "javascript:alert(1)",
    image: "../bad",
    select: "Other",
  }))
    inputs[id] = { enabled: true, text, alt: "", items: [] };
  const before = JSON.stringify(inputs);
  expect(
    Object.keys(parseControls(type, " ", "Bad Slug", inputs, "publish").errors).sort(),
  ).toEqual(["date", "image", "number", "select", "slug", "text", "title", "url"]);
  expect(JSON.stringify(inputs)).toBe(before);
});
