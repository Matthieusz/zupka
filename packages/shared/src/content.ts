import { Effect, Schema, SchemaTransformation } from "effect";

const identifier = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/));

/** Stable entry identity, independent of its editable slug. */
export const EntryId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("EntryId"));

/** Code-configured content-type identifier. */
export const ContentTypeId = identifier.pipe(Schema.brand("ContentTypeId"));

/** Code-configured field identifier. */
export const FieldId = identifier.pipe(Schema.brand("FieldId"));

/** Stable managed-image identity, never a filesystem path or arbitrary URL. */
export const ImageId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("ImageId"));

/** Unicode slugs use lowercase letters/numbers separated by single hyphens. */
export const Slug = Schema.String.check(
  Schema.isPattern(/^[\p{Ll}\p{Lo}\p{N}]+(?:-[\p{Ll}\p{Lo}\p{N}]+)*$/u),
).pipe(Schema.brand("Slug"));

/** Titles and labels must contain visible text; authored whitespace is preserved. */
export const Title = Schema.String.check(Schema.makeFilter((s) => s.trim().length > 0));

/** Timezone-explicit ISO date/time, normalized to UTC without using local timezone. */
export const DateTime = Schema.String.check(
  Schema.isPattern(
    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/,
  ),
  Schema.makeFilter((s) => {
    const day = s.slice(0, 10);
    const parsedDay = new Date(day);

    return (
      Number.isFinite(Date.parse(s)) &&
      Number.isFinite(parsedDay.getTime()) &&
      parsedDay.toISOString().slice(0, 10) === day
    );
  }),
).pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (s) => new Date(s).toISOString(),
      encode: (s) => s,
    }),
  ),
);

/** Web links exclude executable and local-file protocols. */
export const WebUrl = Schema.String.check(
  Schema.makeFilter((s) => {
    const url = URL.parse(s);

    return url !== null && (url.protocol === "https:" || url.protocol === "http:");
  }),
);

/** Alt text belongs to a snapshot's image use, not mutable upload metadata. */
export const ImageReference = Schema.Struct({ imageId: ImageId, alt: Schema.String });

/** All serializable custom-field values. */
export const FieldValue = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Boolean,
  ImageReference,
  Schema.Array(Schema.String),
]);

/** Parsed custom-field value. */
export type FieldValue = typeof FieldValue.Type;

const fieldBase = { id: FieldId, label: Title, required: Schema.Boolean };

const textFields = ["text", "markdown"] as const;

const RawFieldDefinition = Schema.Union([
  ...textFields.map((kind) =>
    Schema.Struct({
      ...fieldBase,
      kind: Schema.Literal(kind),
      default: Schema.optionalKey(Schema.String),
    }),
  ),
  Schema.Struct({
    ...fieldBase,
    kind: Schema.Literal("number"),
    default: Schema.optionalKey(Schema.Finite),
  }),
  Schema.Struct({
    ...fieldBase,
    kind: Schema.Literal("boolean"),
    default: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    ...fieldBase,
    kind: Schema.Literal("datetime"),
    default: Schema.optionalKey(DateTime),
  }),
  Schema.Struct({ ...fieldBase, kind: Schema.Literal("url"), default: Schema.optionalKey(WebUrl) }),
  Schema.Struct({
    ...fieldBase,
    kind: Schema.Literal("image"),
    default: Schema.optionalKey(ImageReference),
  }),
  Schema.Struct({
    ...fieldBase,
    kind: Schema.Literal("text-list"),
    default: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    ...fieldBase,
    kind: Schema.Literal("select"),
    choices: Schema.Array(Title).check(
      Schema.isMinLength(1),
      Schema.makeFilter((choices) => new Set(choices).size === choices.length),
    ),
    default: Schema.optionalKey(Schema.String),
  }),
]);

/** Definition-driven value schema; shared by server and generated admin editors. */
export function fieldValueSchema(field: typeof RawFieldDefinition.Type) {
  switch (field.kind) {
    case "text":
    case "markdown":
      return Schema.String;
    case "number":
      return Schema.Finite;
    case "boolean":
      return Schema.Boolean;
    case "datetime":
      return DateTime;
    case "url":
      return WebUrl;
    case "image":
      return ImageReference;
    case "text-list":
      return Schema.Array(Schema.String);
    case "select":
      return Schema.String.check(Schema.makeFilter((s) => field.choices.includes(s)));
  }
}

const reservedFields = new Set([
  "title",
  "slug",
  "id",
  "type",
  "fields",
  "draft",
  "published",
  "createdAt",
  "updatedAt",
  "firstPublishedAt",
  "publishedAt",
  "revision",
  "constructor",
  "prototype",
  "__proto__",
]);

/** Serializable field configuration, including validated defaults and fixed choices. */
export const FieldDefinition = RawFieldDefinition.check(
  Schema.makeFilter((field) => {
    if (reservedFields.has(field.id)) return "Field identifier is reserved";

    if (
      field.default !== undefined &&
      !Schema.is(Schema.toType(fieldValueSchema(field)))(field.default)
    ) {
      return "Default must satisfy the field schema and select choices";
    }

    return true;
  }),
);

/** Parsed field configuration. */
export type FieldDefinition = typeof FieldDefinition.Type;

/** Safe admin-facing description; contains no functions, paths, credentials, or runtime config. */
export const ContentTypeDefinition = Schema.Struct({
  id: ContentTypeId,
  label: Title,
  fields: Schema.Array(FieldDefinition),
}).check(
  Schema.makeFilter(
    (type) =>
      new Set(type.fields.map((field) => field.id)).size === type.fields.length ||
      "Duplicate field identifiers",
  ),
);

/** Parsed content-type description. */
export interface ContentTypeDefinition extends Schema.Schema.Type<typeof ContentTypeDefinition> {}

/** Deployment configuration rejects duplicate type identities. */
export const ContentConfiguration = Schema.Array(ContentTypeDefinition).check(
  Schema.makeFilter(
    (types) =>
      new Set(types.map((type) => type.id)).size === types.length ||
      "Duplicate content-type identifiers",
  ),
);

/** Expected invalid configuration failure; retains Schema diagnostics internally. */
export class InvalidContentConfiguration extends Schema.TaggedError<
  InvalidContentConfiguration,
  { readonly brand: unique symbol }
>()("InvalidContentConfiguration", { cause: Schema.Defect() }) {}

/** Expected invalid draft or publication failure. */
export class InvalidEntry extends Schema.TaggedError<
  InvalidEntry,
  { readonly brand: unique symbol }
>()("InvalidEntry", {
  mode: Schema.Literals(["draft", "publish"]),
  cause: Schema.Defect(),
}) {}

/** Decode configuration at startup or when receiving the safe description in the admin. */
export const parseContentConfiguration = Schema.decodeUnknownEffect(ContentConfiguration, {
  onExcessProperty: "error",
});

/** Build strict draft/publication schemas from the exact same configured field definitions.
 * Required custom fields may be absent in drafts; supplied values are always validated.
 * No defaults are installed here, so reading/saving old content cannot silently modify it.
 */
export function entrySchemas(type: ContentTypeDefinition) {
  const draftFields: Record<string, Schema.optionalKey<ReturnType<typeof fieldValueSchema>>> = {};

  const publishFields: Record<
    string,
    ReturnType<typeof fieldValueSchema> | Schema.optionalKey<ReturnType<typeof fieldValueSchema>>
  > = {};

  for (const field of type.fields) {
    const value = fieldValueSchema(field);
    draftFields[field.id] = Schema.optionalKey(value);
    publishFields[field.id] = field.required ? value : Schema.optionalKey(value);
  }

  const identity = { title: Title, slug: Slug };

  return {
    draft: Schema.Struct({ ...identity, fields: Schema.Struct(draftFields) }),
    publish: Schema.Struct({ ...identity, fields: Schema.Struct(publishFields) }),
  };
}

/** Parse an untrusted draft or publish payload and retain normalized field values. */
// This is the decoding boundary itself, not a domain operation accepting unparsed input.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function parseEntry(type: ContentTypeDefinition, mode: "draft" | "publish", input: unknown) {
  return Schema.decodeUnknownEffect(entrySchemas(type)[mode], { onExcessProperty: "error" })(
    input,
  ).pipe(Effect.mapError((cause) => new InvalidEntry({ mode, cause })));
}

/** Decode creation input and apply defaults only here; explicit false/zero values win. */
// Creation is also a decoding boundary; parseEntry validates before defaults are merged.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function createDraft(type: ContentTypeDefinition, input: unknown) {
  const defaults: Record<string, FieldValue> = {};

  for (const field of type.fields) {
    if (field.default !== undefined) defaults[field.id] = field.default;
  }

  return parseEntry(type, "draft", input).pipe(
    Effect.flatMap((draft) =>
      parseEntry(type, "draft", { ...draft, fields: { ...defaults, ...draft.fields } }),
    ),
  );
}

/** Pure suggestion; unsupported/empty titles fall back to "entry", never randomness or clock time. */
export function suggestSlug(title: string) {
  return (
    title
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{Ll}\p{Lo}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "") || "entry"
  );
}

/** Snapshot envelope for persisted drafts; field rules are supplied by entrySchemas. */
export const DraftData = Schema.Struct({
  entryId: EntryId,
  typeId: ContentTypeId,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  updatedAt: DateTime,
  content: Schema.Struct({
    title: Title,
    slug: Slug,
    fields: Schema.Record(Schema.String, FieldValue),
  }),
});

/** Current public version retains the independent first-publication timestamp. */
export const PublicationData = Schema.Struct({
  entryId: EntryId,
  typeId: ContentTypeId,
  firstPublishedAt: DateTime,
  publishedAt: DateTime,
  content: DraftData.fields.content,
});
