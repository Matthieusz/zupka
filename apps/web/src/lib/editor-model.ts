import { Schema, Result, Match } from "effect";
import {
  fieldValueSchema,
  ImageReference,
  Slug,
  Title,
  type ContentTypeDefinition,
  type FieldValue,
} from "@zupka/shared";
import type { AdminEntry } from "@zupka/contracts";

/** Unparsed authored input is deliberately separate from saved, schema-decoded content. */
export interface FieldInput {
  enabled: boolean;
  text: string;
  alt: string;
  items: string[];
}

/** Builds controls from an existing snapshot; defaults are supplied only for a new entry. */
export function fieldInputs(type: ContentTypeDefinition, saved: typeof AdminEntry.Type | null) {
  const inputs: Record<string, FieldInput> = {};

  for (const field of type.fields) {
    const value = saved ? saved.draft.fields[field.id] : field.default;
    inputs[field.id] = {
      enabled: value !== undefined,
      text: Schema.is(ImageReference)(value)
        ? value.imageId
        : Array.isArray(value)
          ? value.join("\n")
          : value === undefined
            ? field.kind === "boolean"
              ? "false"
              : ""
            : String(value),
      alt: Schema.is(ImageReference)(value) ? value.alt : "",
      items: Array.isArray(value) ? [...value] : [],
    };
  }

  return inputs;
}

/** Parses raw controls through the shared schemas, returning label-safe inline diagnostics. */
export function parseControls(
  type: ContentTypeDefinition,
  title: string,
  slug: string,
  inputs: Record<string, FieldInput>,
  mode: "draft" | "publish",
) {
  const errors: Record<string, string> = {};
  const fields: Record<string, FieldValue> = {};
  const parsedTitle = Schema.decodeResult(Title)(title);
  const parsedSlug = Schema.decodeResult(Slug)(slug);

  if (Result.isFailure(parsedTitle)) errors.title = "Enter a title.";

  if (Result.isFailure(parsedSlug))
    errors.slug = "Use lowercase letters or numbers separated by single hyphens.";

  for (const field of type.fields) {
    const input = inputs[field.id];

    if (!input?.enabled) {
      if (mode === "publish" && field.required) errors[field.id] = "Required for publication.";
      continue;
    }

    const candidate: Result.Result<
      string | number | boolean | string[] | { imageId: string; alt: string },
      Schema.SchemaError
    > = Match.value(field.kind).pipe(
      Match.when("number", () => Schema.decodeResult(Schema.FiniteFromString)(input.text)),
      Match.when("boolean", () =>
        Schema.decodeUnknownResult(Schema.Literals(["true", "false"]))(input.text).pipe(
          Result.map((value) => value === "true"),
        ),
      ),
      Match.when("text-list", () => Result.succeed(input.items)),
      Match.when("image", () => Result.succeed({ imageId: input.text, alt: input.alt })),
      Match.orElse(() => Result.succeed(input.text)),
    );

    if (Result.isFailure(candidate)) {
      errors[field.id] =
        field.kind === "number" ? "Enter a finite number." : "Choose True or False.";
      continue;
    }

    const parsed = Schema.decodeUnknownResult(fieldValueSchema(field))(candidate.success);

    if (Result.isFailure(parsed))
      errors[field.id] =
        field.kind === "datetime"
          ? "Enter an ISO date and time with timezone, for example 2026-10-14T12:00:00Z."
          : `Enter a valid ${field.label.toLowerCase()}.`;
    else fields[field.id] = parsed.success;
  }

  if (
    Result.isFailure(parsedTitle) ||
    Result.isFailure(parsedSlug) ||
    Object.keys(errors).length > 0
  )
    return { errors, content: null };

  return { errors, content: { title: parsedTitle.success, slug: parsedSlug.success, fields } };
}
