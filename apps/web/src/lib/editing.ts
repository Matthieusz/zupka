import {
  EntriesApi,
  ImagesApi,
  EntryError,
  EntryInvalid,
  ImageInUse,
  ImageInvalid,
  ImageTooLarge,
  ImageBusy,
} from "@zupka/contracts";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientError } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import type { AdminEntry } from "@zupka/contracts";
import { InvalidImageReference, type ContentTypeId, type ImageId } from "@zupka/shared";

/** Safe editor failure; no authored values or infrastructure diagnostics are displayed. */
export class EditorError extends Schema.TaggedError<
  EditorError,
  { readonly brand: unique symbol }
>()("EditorError", {
  reason: Schema.Literals([
    "session-expired",
    "forbidden",
    "stale-revision",
    "slug-taken",
    "slug-locked",
    "published-entry",
    "invalid",
    "image-in-use",
    "image-invalid",
    "image-too-large",
    "image-busy",
    "unavailable",
  ]),
}) {}

// Transport and contract errors are classified exactly once at the browser boundary.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function failure(error: unknown) {
  if (Schema.is(EditorError)(error)) return error;

  if (Schema.is(InvalidImageReference)(error)) return new EditorError({ reason: "invalid" });

  if (Schema.is(EntryError)(error)) return new EditorError({ reason: error.reason });

  if (Schema.is(EntryInvalid)(error)) return new EditorError({ reason: "invalid" });

  if (Schema.is(ImageInUse)(error)) return new EditorError({ reason: "image-in-use" });

  if (Schema.is(ImageInvalid)(error)) return new EditorError({ reason: "image-invalid" });

  if (Schema.is(ImageTooLarge)(error)) return new EditorError({ reason: "image-too-large" });

  if (Schema.is(ImageBusy)(error)) return new EditorError({ reason: "image-busy" });
  const status = HttpClientError.isHttpClientError(error) ? error.response?.status : undefined;

  if (status === 401) return new EditorError({ reason: "session-expired" });

  if (status === 403) return new EditorError({ reason: "forbidden" });

  return new EditorError({ reason: "unavailable" });
}

const options = {
  transformClient: (client: HttpClient.HttpClient) =>
    HttpClient.mapRequest(client, HttpClientRequest.setHeader("x-effect-auth-csrf", "1")),
};

/** Loads the latest revision without modifying local editor input. */
export const getEntry = Effect.fn("Web.getEntry")(
  function* (entry: typeof AdminEntry.Type) {
    const api = yield* HttpApiClient.make(EntriesApi, options);

    return yield* api.entries.get({ params: { typeId: entry.typeId, entryId: entry.id } });
  },
  Effect.provide(FetchHttpClient.layer),
  Effect.mapError(failure),
);

/** Only creation and saving carry authored content; transitions require an existing revision. */
export type EntryCommand =
  | {
      readonly kind: "create";
      readonly typeId: typeof ContentTypeId.Type;
      readonly content: typeof AdminEntry.Type.draft;
    }
  | {
      readonly kind: "save";
      readonly entry: typeof AdminEntry.Type;
      readonly content: typeof AdminEntry.Type.draft;
    }
  | { readonly kind: "publish" | "unpublish" | "delete"; readonly entry: typeof AdminEntry.Type };

/** Explicit entry command; publishing never submits unsaved content. */
export const writeEntry = Effect.fn("Web.writeEntry")(
  function* (command: EntryCommand) {
    const api = yield* HttpApiClient.make(EntriesApi, options);

    if (command.kind === "create")
      return yield* api.entries.create({
        params: { typeId: command.typeId },
        payload: command.content,
      });
    const params = { typeId: command.entry.typeId, entryId: command.entry.id };
    const revision = command.entry.revision;

    switch (command.kind) {
      case "save":
        return yield* api.entries.save({ params, payload: { revision, content: command.content } });
      case "publish":
        return yield* api.entries.publish({ params, payload: { revision } });
      case "unpublish":
        return yield* api.entries.unpublish({ params, payload: { revision } });
      case "delete":
        yield* api.entries.delete({ params, payload: { revision } });

        return null;
    }
  },
  Effect.provide(FetchHttpClient.layer),
  Effect.mapError(failure),
);

/** Reads a bounded private library page. */
export const listImages = Effect.fn("Web.listImages")(
  function* (offset: number) {
    const api = yield* HttpApiClient.make(ImagesApi, options);

    return yield* api.images.list({ query: { offset, limit: 20 } });
  },
  Effect.provide(FetchHttpClient.layer),
  Effect.mapError(failure),
);

/** Uploads raw bytes; the server verifies actual format, size and dimensions. */
export const uploadImage = Effect.fn("Web.uploadImage")(
  function* (file: File) {
    const bytes = yield* Effect.tryPromise({
      try: () => file.arrayBuffer(),
      catch: () => new EditorError({ reason: "image-invalid" }),
    });

    const api = yield* HttpApiClient.make(ImagesApi, options);

    return yield* api.images.upload({ payload: new Uint8Array(bytes) });
  },
  Effect.provide(FetchHttpClient.layer),
  Effect.mapError(failure),
);

/** Deletes an unreferenced image; reference conflicts remain actionable failures. */
export const deleteImage = Effect.fn("Web.deleteImage")(
  function* (imageId: typeof ImageId.Type) {
    const api = yield* HttpApiClient.make(ImagesApi, options);

    return yield* api.images.delete({ params: { imageId } });
  },
  Effect.provide(FetchHttpClient.layer),
  Effect.mapError(failure),
);

/** Safe recovery copy for every expected editor failure. */
export const editorMessages: Record<EditorError["reason"], string> = {
  "session-expired": "Your session ended. Sign in again; your editor input is retained.",
  forbidden: "Access denied. Use the configured admin origin and owner account.",
  "stale-revision":
    "This entry changed elsewhere. Your input is retained. Load the latest saved version to compare; nothing will be merged or overwritten automatically.",
  "slug-taken": "This slug is already used in this content type. Choose another slug.",
  "slug-locked": "The slug is locked after first publication. Load the latest saved version.",
  "published-entry": "Unpublish this entry before deleting it.",
  invalid:
    "The server rejected this content. Check the configured fields and image references, then try again.",
  "image-in-use":
    "This image is referenced by a saved draft or published version. Remove those references and save or republish each entry before deleting it.",
  "image-invalid": "Choose a valid JPEG, PNG, WebP or GIF image.",
  "image-too-large": "The image exceeds 10 MiB. Choose a smaller file.",
  "image-busy": "Image processing is busy. Wait a moment and try again.",
  unavailable:
    "The request could not be confirmed. Your input is retained. Check your connection and reload the saved version before retrying an uncertain write.",
};
