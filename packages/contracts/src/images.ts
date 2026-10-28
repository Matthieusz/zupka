import { DateTime, EntryId, ImageId, MaximumImageBytes } from "@zupka/shared";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

/** Verified on-disk image metadata; paths and untrusted original filenames are never serialized. */
export const ManagedImage = Schema.Struct({
  id: ImageId,
  mediaType: Schema.Literals(["image/jpeg", "image/png", "image/webp", "image/gif"]),
  bytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MaximumImageBytes })),
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
  createdAt: DateTime,
  state: Schema.Literals(["active", "deleting"]),
  url: Schema.String,
});

/** Bounded image-library pagination, newest first with an immutable ID tie-breaker. */
export const ImageListQuery = Schema.Struct({
  limit: Schema.optionalKey(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })),
  ),
  offset: Schema.optionalKey(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: 1_000_000 }),
    ),
  ),
});

/** Private library page; deleting tombstones remain visible so failed cleanup can be retried. */
export const ImagePage = Schema.Struct({
  items: Schema.Array(ManagedImage),
  total: Schema.Int,
  limit: Schema.Int,
  offset: Schema.Int,
});

/** Unsupported, malformed or undecodable image bytes, independent of claimed MIME type. */
export class ImageInvalid extends Schema.TaggedError<
  ImageInvalid,
  { readonly brand: unique symbol }
>()("ImageInvalid", {}, { httpApiStatus: 400 }) {}

/** The encoded image exceeded 10 MiB. */
export class ImageTooLarge extends Schema.TaggedError<
  ImageTooLarge,
  { readonly brand: unique symbol }
>()("ImageTooLarge", {}, { httpApiStatus: 413 }) {}

/** Unknown or unavailable image. */
export class ImageNotFound extends Schema.TaggedError<
  ImageNotFound,
  { readonly brand: unique symbol }
>()("ImageNotFound", {}, { httpApiStatus: 404 }) {}

/** Saved references prevent deletion; includes entry identity/kind, never authored content. */
export class ImageInUse extends Schema.TaggedError<ImageInUse, { readonly brand: unique symbol }>()(
  "ImageInUse",
  {
    references: Schema.Array(
      Schema.Struct({ entryId: EntryId, kind: Schema.Literals(["draft", "published"]) }),
    ),
  },
  { httpApiStatus: 409 },
) {}

/** Concurrent upload admission is bounded, without an unbounded waiting queue. */
export class ImageBusy extends Schema.TaggedError<ImageBusy, { readonly brand: unique symbol }>()(
  "ImageBusy",
  {},
  { httpApiStatus: 429 },
) {}

/** Opaque storage failure; a failed deletion can be safely retried. */
export class ImageUnavailable extends Schema.TaggedError<
  ImageUnavailable,
  { readonly brand: unique symbol }
>()("ImageUnavailable", {}, { httpApiStatus: 503 }) {}

const errors = [
  ImageInvalid,
  ImageTooLarge,
  ImageNotFound,
  ImageInUse,
  ImageBusy,
  ImageUnavailable,
];

/** Owner-only image operations; upload uses raw bytes, never multipart filenames or claimed types. */
export const ImagesApi = HttpApi.make("images").add(
  HttpApiGroup.make("images")
    .add(
      HttpApiEndpoint.post("upload", "/api/admin/images", {
        payload: Schema.Uint8Array.pipe(
          HttpApiSchema.asUint8Array({ contentType: "application/octet-stream" }),
        ),
        success: ManagedImage,
        error: errors,
      }),
    )
    .add(
      HttpApiEndpoint.get("list", "/api/admin/images", {
        query: ImageListQuery,
        success: ImagePage,
        error: errors,
      }),
    )
    .add(
      HttpApiEndpoint.get("get", "/api/admin/images/:imageId", {
        params: { imageId: ImageId },
        success: ManagedImage,
        error: errors,
      }),
    )
    .add(
      HttpApiEndpoint.delete("delete", "/api/admin/images/:imageId", {
        params: { imageId: ImageId },
        success: Schema.Struct({ deleted: ImageId }),
        error: errors,
      }),
    ),
);
