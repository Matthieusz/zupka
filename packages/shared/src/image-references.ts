import { Effect, Schema } from "effect";
import type { Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { normalizeIdentifier } from "micromark-util-normalize-identifier";
import { ContentTypeDefinition, DraftData, ImageId, ImageReference } from "./content.js";

/** Maximum encoded image size; request streams enforce this independently of claimed length. */
export const MaximumImageBytes = 10 * 1024 * 1024;

/** Stable managed Markdown destination and eventual access-checked image URL. */
export function managedImageUrl(id: typeof ImageId.Type) {
  return `/api/images/${id}`;
}

/** A saved managed destination is malformed or refers to an unavailable image; never includes Markdown source. */
export class InvalidImageReference extends Schema.TaggedError<
  InvalidImageReference,
  { readonly brand: unique symbol }
>()("InvalidImageReference", {
  reason: Schema.Literals(["invalid-destination", "missing-image"]),
  imageId: Schema.optionalKey(ImageId),
}) {}

function walk(node: Root | RootContent, visit: (node: Root | RootContent) => void) {
  visit(node);

  if ("children" in node) for (const child of node.children) walk(child, visit);
}

const markdownDestinations = (source: string) => {
  const tree = fromMarkdown(source);
  const definitions = new Map<string, string>();
  const destinations: string[] = [];
  walk(tree, (node) => {
    if (node.type === "definition") {
      const key = normalizeIdentifier(node.identifier);

      if (!definitions.has(key)) definitions.set(key, node.url);
    }
  });
  walk(tree, (node) => {
    if (node.type === "image") destinations.push(node.url);

    if (node.type === "imageReference") {
      const destination = definitions.get(normalizeIdentifier(node.identifier));

      if (destination !== undefined) destinations.push(destination);
    }
  });

  return destinations;
};

/** Extract managed references from configured image fields and CommonMark image nodes in every Markdown field.
 * Inline/code fences, ordinary links, unused definitions, and raw HTML are not Markdown image nodes.
 * External destinations are not managed; reserved /api/images destinations must use the exact generated URL.
 */
export const extractImageReferences = Effect.fn("Content.extractImageReferences")(function* (
  type: ContentTypeDefinition,
  content: typeof DraftData.fields.content.Type,
) {
  const ids = new Set<typeof ImageId.Type>();

  for (const field of type.fields) {
    const value = content.fields[field.id];

    if (value === undefined) continue;

    if (field.kind === "image") {
      const reference = yield* Schema.decodeUnknownEffect(ImageReference)(value).pipe(
        Effect.mapError(() => new InvalidImageReference({ reason: "invalid-destination" })),
      );

      ids.add(reference.imageId);
    }

    if (field.kind === "markdown") {
      const source = yield* Schema.decodeUnknownEffect(Schema.String)(value).pipe(
        Effect.mapError(() => new InvalidImageReference({ reason: "invalid-destination" })),
      );

      for (const destination of markdownDestinations(source)) {
        // Detect alternate spellings that a browser/proxy can normalize to the reserved image route.
        const url = URL.parse(destination, "https://managed.invalid");

        const path = yield* Effect.try({
          try: () => decodeURIComponent(url?.pathname ?? ""),
          catch: () => new InvalidImageReference({ reason: "invalid-destination" }),
        });

        if (
          !destination.startsWith("/api/images") &&
          !path.replace(/\/+/g, "/").startsWith("/api/images")
        )
          continue;

        const id = yield* Schema.decodeEffect(ImageId)(
          destination.slice("/api/images/".length),
        ).pipe(Effect.mapError(() => new InvalidImageReference({ reason: "invalid-destination" })));

        if (destination !== managedImageUrl(id))
          return yield* new InvalidImageReference({ reason: "invalid-destination" });
        ids.add(id);
      }
    }
  }

  return [...ids];
});
