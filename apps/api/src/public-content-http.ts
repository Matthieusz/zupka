import { EntryUnavailable, PublicContentApi } from "@zupka/contracts";
import { Config, Effect, Layer, Schema } from "effect";
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  getPublicEntry,
  listPublicEntries,
  PublicContentStorageFailure,
} from "./public-content.js";

const transport = <A, E, R>(effect: Effect.Effect<A, E | PublicContentStorageFailure, R>) =>
  effect.pipe(
    Effect.catchTag("PublicContentStorageFailure", () => Effect.fail(new EntryUnavailable({}))),
  );

const Origins = Schema.Array(Schema.String).check(
  Schema.makeFilter(
    (origins) =>
      (origins.length === 1 && origins[0] === "*") ||
      (origins.length > 0 &&
        origins.every((origin) => {
          const url = URL.parse(origin);

          return (
            url !== null &&
            url.origin === origin &&
            !origin.includes("*") &&
            (url.protocol === "https:" || url.protocol === "http:")
          );
        })),
  ),
);

/** Invalid public CORS configuration fails startup without disclosing raw environment values. */
export class PublicReadConfigurationError extends Schema.TaggedError<
  PublicReadConfigurationError,
  { readonly brand: unique symbol }
>()("PublicReadConfigurationError", { message: Schema.String }) {}

/** Parse public-only CORS: wildcard (default), or comma-separated exact HTTP(S) origins; never credentials. */
export const loadPublicReadOrigins = Effect.gen(function* () {
  const raw = yield* Config.String("PUBLIC_READ_ORIGINS").pipe(Config.withDefault("*"));

  return yield* Schema.decodeEffect(Origins)(raw.split(",").map((origin) => origin.trim())).pipe(
    Effect.mapError(
      () =>
        new PublicReadConfigurationError({
          message: "PUBLIC_READ_ORIGINS must be * or comma-separated exact HTTP(S) origins.",
        }),
    ),
  );
});

const publicMiddleware = HttpRouter.middleware()(
  Effect.gen(function* () {
    const origins = yield* loadPublicReadOrigins;

    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const origin = request.headers.origin;

        const allow = origins.includes("*")
          ? "*"
          : origin !== undefined && origins.includes(origin)
            ? origin
            : undefined;

        const headers = {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          vary: "Origin",
        };

        // The API builder reports malformed requests as defects, converted outside route middleware.
        // A request-owned pre-response hook covers those 400s as well as successes and declared errors.
        yield* HttpEffect.appendPreResponseHandler((_request, response) => {
          const uncached = HttpServerResponse.setHeaders(response, headers);

          return Effect.succeed(
            allow === undefined
              ? uncached
              : HttpServerResponse.setHeaders(uncached, {
                  "access-control-allow-origin": allow,
                  "access-control-allow-methods": "GET, HEAD, OPTIONS",
                }),
          );
        });

        return yield* effect;
      });
  }),
).layer;

const handlers = HttpApiBuilder.group(PublicContentApi, "content", (group) =>
  group
    .handle("list", ({ params, query }) => transport(listPublicEntries(params.typeId, query)))
    .handle("get", ({ params }) => transport(getPublicEntry(params.typeId, params.slug))),
);

const preflight = Effect.succeed(HttpServerResponse.empty({ status: 204 }));

/** Anonymous publication routes only. This middleware never wraps auth/admin/private-image traffic.
 * Conditional requests still execute current reads and cannot produce a stale reusable 304 response.
 */
export const PublicContentRoutes = Layer.mergeAll(
  HttpApiBuilder.layer(PublicContentApi).pipe(Layer.provide(handlers)),
  HttpRouter.add("OPTIONS", "/api/content/:typeId", preflight),
  HttpRouter.add("OPTIONS", "/api/content/:typeId/:slug", preflight),
).pipe(Layer.provide(publicMiddleware));
