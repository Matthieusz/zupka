import { Effect, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  ContentConfiguration,
  ContentTypeDefinition,
  DateTime,
  DraftData,
  EntryId,
  FieldDefinition,
  ImageId,
  InvalidEntry,
  PublicationData,
  Slug,
  createDraft,
  entrySchemas,
  fieldValueSchema,
  parseContentConfiguration,
  parseEntry,
  suggestSlug,
} from "./index.ts";

const image = { imageId: "550e8400-e29b-41d4-a716-446655440000", alt: "A view" };

const identity = { title: "Hello", slug: "hello" };

const parseType = Schema.decodeUnknownSync(ContentTypeDefinition, { onExcessProperty: "error" });

const field = (kind: string, extra = {}) => ({
  id: "value",
  label: "Value",
  kind,
  required: true,
  ...extra,
});

const typeWith = (definition: typeof FieldDefinition.Encoded) =>
  parseType({ id: "example", label: "Example", fields: [definition] });

describe("definition-driven content schemas", () => {
  const cases = [
    { kind: "text", valid: "hello", invalid: 1 },
    { kind: "number", valid: 0, invalid: "1" },
    { kind: "boolean", valid: false, invalid: "false" },
    { kind: "datetime", valid: "2025-01-01T12:30:00+02:00", invalid: "2025-02-29T12:00:00Z" },
    { kind: "url", valid: "https://example.org/path", invalid: "javascript:alert(1)" },
    { kind: "markdown", valid: "# Heading\n![view](image:123)", invalid: {} },
    { kind: "image", valid: image, invalid: { imageId: "../file", alt: "" } },
    { kind: "select", valid: "One", invalid: "Other", extra: { choices: ["One", "Two"] } },
    { kind: "text-list", valid: ["TypeScript", "Svelte"], invalid: ["TypeScript", 1] },
  ];

  for (const test of cases) {
    it(`validates ${test.kind} in drafts and publications`, async () => {
      const type = parseType({
        id: "example",
        label: "Example",
        fields: [field(test.kind, test.extra)],
      });

      for (const mode of ["draft", "publish"] as const) {
        const parsed = await Effect.runPromise(
          parseEntry(type, mode, { ...identity, fields: { value: test.valid } }),
        );

        expect(parsed.fields.value).toEqual(
          test.kind === "datetime" ? "2025-01-01T10:30:00.000Z" : test.valid,
        );

        const error = await Effect.runPromise(
          Effect.flip(parseEntry(type, mode, { ...identity, fields: { value: test.invalid } })),
        );

        expect(error).toBeInstanceOf(InvalidEntry);
        expect(error.mode).toBe(mode);
      }

      const schemas = entrySchemas(type);
      expect(Schema.is(schemas.draft)({ ...identity, fields: {} })).toBe(true);
      expect(Schema.is(schemas.publish)({ ...identity, fields: {} })).toBe(false);
      expect(Schema.is(schemas.publish)({ ...identity, fields: { value: null } })).toBe(false);
    });
  }

  it("requires title and slug even for incomplete drafts and empty custom types", async () => {
    const type = parseType({ id: "notes", label: "Notes", fields: [] });

    for (const content of [
      { fields: {} },
      { ...identity, title: "  ", fields: {} },
      { ...identity, slug: "", fields: {} },
      { ...identity, slug: "Not a slug", fields: {} },
    ]) {
      expect(
        await Effect.runPromise(Effect.flip(parseEntry(type, "draft", content))),
      ).toBeInstanceOf(InvalidEntry);
    }

    expect(
      await Effect.runPromise(parseEntry(type, "publish", { ...identity, fields: {} })),
    ).toEqual({ ...identity, fields: {} });
  });

  it("rejects unknown fields rather than silently dropping data", async () => {
    const type = typeWith({ id: "body", label: "Body", kind: "markdown", required: false });

    for (const input of [
      { ...identity, fields: { unknown: "lost?" } },
      { ...identity, fields: {}, secret: "lost?" },
    ]) {
      expect(await Effect.runPromise(Effect.flip(parseEntry(type, "draft", input)))).toBeInstanceOf(
        InvalidEntry,
      );
    }
  });

  it("applies defaults only on creation and respects explicit false, zero and empty lists", async () => {
    const type = parseType({
      id: "example",
      label: "Example",
      fields: [
        field("boolean", { id: "flag", default: true }),
        field("number", { id: "count", default: 10 }),
        field("text-list", { id: "tags", default: ["default"] }),
        field("datetime", { id: "date", default: "2025-01-01T12:30:00+02:00" }),
        field("text", { id: "needed" }),
      ],
    });

    const empty = { ...identity, fields: {} };
    expect((await Effect.runPromise(parseEntry(type, "draft", empty))).fields).toEqual({});
    const created = await Effect.runPromise(createDraft(type, empty));
    expect(created.fields).toEqual({
      flag: true,
      count: 10,
      tags: ["default"],
      date: "2025-01-01T10:30:00.000Z",
    });

    const explicit = await Effect.runPromise(
      createDraft(type, { ...identity, fields: { flag: false, count: 0, tags: [] } }),
    );

    expect(explicit.fields).toMatchObject({ flag: false, count: 0, tags: [] });
    expect(
      await Effect.runPromise(
        Effect.flip(createDraft(type, { ...identity, fields: { flag: null } })),
      ),
    ).toBeInstanceOf(InvalidEntry);
    expect(await Effect.runPromise(Effect.flip(parseEntry(type, "publish", empty)))).toBeInstanceOf(
      InvalidEntry,
    );
  });

  it("round-trips safe JSON descriptions and rebuilds identical admin schemas", async () => {
    const server = typeWith({
      id: "format",
      label: "Format",
      kind: "select",
      required: true,
      choices: ["One", "Two"],
      default: "One",
    });

    const wire = Schema.encodeSync(ContentConfiguration)([server]);

    const [admin] = await Effect.runPromise(
      parseContentConfiguration(JSON.parse(JSON.stringify(wire))),
    );

    expect(admin).toEqual(server);

    if (!admin) throw new Error("Missing decoded type");
    const content = await Effect.runPromise(createDraft(server, { ...identity, fields: {} }));
    expect(await Effect.runPromise(parseEntry(admin, "publish", content))).toEqual(content);
  });
});

describe("configuration validation", () => {
  it("rejects malformed definitions and defaults for every field kind", () => {
    const invalid = [
      field("unknown"),
      field("select", { choices: [] }),
      field("select", { choices: ["One", "One"] }),
      field("select", { choices: [" "] }),
      field("select", { choices: ["One"], default: "Two" }),
      field("text", { default: 1 }),
      field("number", { default: Infinity }),
      field("boolean", { default: "false" }),
      field("datetime", { default: "yesterday" }),
      field("url", { default: "file:///tmp/private" }),
      field("markdown", { default: [] }),
      field("image", { default: { imageId: "bad", alt: "x" } }),
      field("text-list", { default: [1] }),
      field("text", { required: "yes" }),
      field("text", { label: "" }),
      field("text", { id: "Bad ID" }),
    ];

    for (const definition of invalid) {
      expect(() => parseType({ id: "example", label: "Example", fields: [definition] })).toThrow();
    }
  });

  it("rejects reserved collisions, duplicate fields/types and unsafe description properties", () => {
    for (const id of [
      "title",
      "slug",
      "id",
      "type",
      "fields",
      "draft",
      "published",
      "revision",
      "constructor",
      "prototype",
      "__proto__",
    ]) {
      expect(() =>
        parseType({ id: "example", label: "Example", fields: [field("text", { id })] }),
      ).toThrow();
    }

    expect(() =>
      parseType({ id: "example", label: "Example", fields: [field("text"), field("number")] }),
    ).toThrow();
    const type = typeWith({ id: "body", label: "Body", kind: "markdown", required: false });
    expect(() => Schema.decodeUnknownSync(ContentConfiguration)([type, type])).toThrow();
    expect(() => parseType({ id: "bad type", label: "Example", fields: [] })).toThrow();
    expect(() => parseType({ ...type, databasePath: "/private" })).toThrow();
    expect(() =>
      parseType({ ...type, fields: [field("text", { validate: () => true })] }),
    ).toThrow();
  });

  it("reuses field schemas for valid defaults of all kinds", () => {
    const definitions = [
      field("text", { default: "" }),
      field("markdown", { default: "# Text" }),
      field("number", { default: 0 }),
      field("boolean", { default: false }),
      field("datetime", { default: "2025-01-01T00:00:00Z" }),
      field("url", { default: "https://example.com" }),
      field("image", { default: image }),
      field("select", { choices: ["One"], default: "One" }),
      field("text-list", { default: [] }),
    ];

    for (const definition of definitions) {
      const parsed = Schema.decodeUnknownSync(FieldDefinition)(definition);
      expect(Schema.is(Schema.toType(fieldValueSchema(parsed)))(parsed.default)).toBe(true);
    }
  });
});

describe("identity and snapshot primitives", () => {
  it("keeps slug suggestions deterministic and valid across languages", () => {
    for (const title of [
      "Hello, World!",
      "Příliš žluťoučký kůň",
      "日本語 の記事",
      "مرحبا بالعالم",
      "!!!",
      "",
    ]) {
      const suggestion = suggestSlug(title);
      expect(suggestion).toBe(suggestSlug(title));
      expect(Schema.is(Slug)(suggestion)).toBe(true);
    }

    expect(suggestSlug("Hello, World!")).toBe("hello-world");
    expect(suggestSlug("Příliš žluťoučký kůň")).toBe("prilis-zlutoucky-kun");
  });

  it("normalizes dates independently of local timezone and rejects ambiguous/invalid input", () => {
    expect(Schema.decodeUnknownSync(DateTime)("2025-01-01T12:00:00-05:00")).toBe(
      "2025-01-01T17:00:00.000Z",
    );

    for (const value of ["2025-01-01", "2025-01-01T12:00:00", "2025-02-30T12:00:00Z", "nonsense"]) {
      expect(() => Schema.decodeUnknownSync(DateTime)(value)).toThrow();
    }
  });

  it("validates stable identifiers and draft/publication envelopes", () => {
    expect(Schema.is(EntryId)(image.imageId)).toBe(true);
    expect(Schema.is(ImageId)("../uploads/image.png")).toBe(false);

    const draft = {
      entryId: image.imageId,
      typeId: "posts",
      revision: 1,
      updatedAt: "2025-01-01T00:00:00Z",
      content: { ...identity, fields: {} },
    };

    expect(Schema.decodeUnknownSync(DraftData)(draft).revision).toBe(1);
    expect(() => Schema.decodeUnknownSync(DraftData)({ ...draft, revision: 0 })).toThrow();
    expect(
      Schema.decodeUnknownSync(PublicationData)({
        entryId: draft.entryId,
        typeId: draft.typeId,
        content: draft.content,
        firstPublishedAt: draft.updatedAt,
        publishedAt: "2025-01-02T00:00:00Z",
      }).firstPublishedAt,
    ).toBe("2025-01-01T00:00:00.000Z");
  });
});
