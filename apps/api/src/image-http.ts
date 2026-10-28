import {
  ImageBusy,
  ImageInvalid,
  ImagesApi,
  ImageTooLarge,
  ImageUnavailable,
  ManagedImage,
} from "@zupka/contracts";
import { ImageId, MaximumImageBytes } from "@zupka/shared";
import { Effect, Layer, Option, Schema, Semaphore, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { ImageStorageFailure } from "./image-storage.js";
import {
  deleteImage,
  getImage,
  imageBytes,
  publicImageBytes,
  listImages,
  uploadImage,
} from "./images.js";
import { OwnerGuard, OwnerGuardLive, ownerRoutes } from "./owner-http.js";

const transport = <A, E, R>(effect: Effect.Effect<A, E | ImageStorageFailure, R>) =>
  effect.pipe(Effect.catchTag("ImageStorageFailure", () => Effect.fail(new ImageUnavailable({}))));

const handlers = HttpApiBuilder.group(ImagesApi, "images", (group) =>
  Effect.gen(function* () {
    const admission = yield* Semaphore.make(2);

    return group
      .handleRaw("upload", ({ request }) =>
        transport(
          Effect.gen(function* () {
            if (Number(request.headers["content-length"]) > MaximumImageBytes)
              return yield* new ImageTooLarge({});

            const result = yield* admission.withPermitsIfAvailable(1)(
              uploadImage(request.stream.pipe(Stream.mapError(() => new ImageInvalid({})))).pipe(
                Effect.timeout("30 seconds"),
                Effect.catchTag("TimeoutError", () => Effect.fail(new ImageInvalid({}))),
              ),
            );

            if (Option.isNone(result)) return yield* new ImageBusy({});

            return result.value;
          }),
        ),
      )
      .handle("list", ({ query }) => transport(listImages(query)))
      .handle("get", ({ params }) => transport(getImage(params.imageId)))
      .handle("delete", ({ params }) => transport(deleteImage(params.imageId)));
  }),
);

const binaryResponse = (
  result: { readonly image: typeof ManagedImage.Type; readonly bytes: Uint8Array },
  head: boolean,
) => {
  const headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "content-type": result.image.mediaType,
    "content-length": String(result.image.bytes),
  };

  // Conditional/range headers never bypass authorization and never produce reusable 304 responses.
  return head
    ? HttpServerResponse.empty({ status: 200, headers })
    : HttpServerResponse.uint8Array(result.bytes, { headers, contentType: result.image.mediaType });
};

const binaryRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const ownerGuard = yield* OwnerGuard;

    const bytes = Effect.gen(function* () {
      const params = yield* HttpRouter.schemaPathParams(Schema.Struct({ imageId: ImageId }));
      const request = yield* HttpServerRequest.HttpServerRequest;

      const respond = (result: Parameters<typeof binaryResponse>[0]) =>
        binaryResponse(result, request.method === "HEAD");

      return yield* publicImageBytes(params.imageId).pipe(
        Effect.map(respond),
        Effect.catchTag("ImageNotFound", () =>
          ownerGuard.protect(imageBytes(params.imageId).pipe(Effect.map(respond))),
        ),
      );
    }).pipe(
      Effect.catchTags({
        SchemaError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
        ImageNotFound: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
        ImageStorageFailure: () => Effect.succeed(HttpServerResponse.empty({ status: 503 })),
      }),
      Effect.map((response) => HttpServerResponse.setHeader(response, "cache-control", "no-store")),
    );

    return HttpRouter.add("GET", "/api/images/:imageId", bytes);
  }),
).pipe(Layer.provide(OwnerGuardLive));

/** Library/uploads always require the owner; binary GET/HEAD also admit current published references.
 * Private reads reuse the exact owner guard, never an alternate cookie or bearer-token bypass.
 */
export const ImageRoutes = Layer.merge(
  ownerRoutes(HttpApiBuilder.layer(ImagesApi).pipe(Layer.provide(handlers))),
  binaryRoutes,
);
