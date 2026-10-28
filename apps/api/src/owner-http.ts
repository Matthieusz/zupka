import { Auth, Http } from "@yielded/auth";
import { Config, Context, Effect, Layer, Option, Predicate, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { AppAuth, AuthLive } from "./auth.js";

const Origin = Schema.String.check(
  Schema.makeFilter((value) => {
    const url = URL.parse(value);

    return (
      url !== null &&
      url.origin === value &&
      !url.hostname.includes("*") &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  }),
);

/** Safe startup failure; never includes raw environment values. */
export class OwnerSecurityConfigurationError extends Schema.TaggedError<
  OwnerSecurityConfigurationError,
  { readonly brand: unique symbol }
>()("OwnerSecurityConfigurationError", { message: Schema.String }) {}

/** Parse one exact trusted admin origin. Production requires explicit HTTPS; HTTP is loopback-only.
 * No cookie domain, wildcard origin, native bypass, or additional credentialed origin is supported.
 */
export const loadOwnerHttpOptions = Effect.gen(function* () {
  const rawMode = yield* Config.String("NODE_ENV").pipe(Config.withDefault("development"));

  const mode = yield* Schema.decodeUnknownEffect(
    Schema.Literals(["development", "test", "production"]),
  )(rawMode).pipe(
    Effect.mapError(
      () =>
        new OwnerSecurityConfigurationError({
          message: "NODE_ENV must be development, test, or production.",
        }),
    ),
  );

  const configured = yield* Config.option(Config.String("AUTH_ORIGIN"));

  if (mode === "production" && Option.isNone(configured)) {
    return yield* new OwnerSecurityConfigurationError({
      message: "Production requires an explicit HTTPS AUTH_ORIGIN.",
    });
  }

  const origin = yield* Schema.decodeUnknownEffect(Origin)(
    Option.getOrElse(configured, () => "http://127.0.0.1:5173"),
  ).pipe(
    Effect.mapError(
      () =>
        new OwnerSecurityConfigurationError({
          message: "AUTH_ORIGIN must be an exact HTTPS origin or a loopback HTTP origin.",
        }),
    ),
  );

  if (mode === "production" && !origin.startsWith("https:")) {
    return yield* new OwnerSecurityConfigurationError({
      message: "Production AUTH_ORIGIN must use HTTPS.",
    });
  }

  return {
    origin,
    trustedOrigins: [origin],
    maximumBodyBytes: 16_384,
    maximumUrlBytes: 2048,
    cookie: { secure: origin.startsWith("https:"), sameSite: "strict" as const },
  };
});

/** Password/session/logout HTTP routes only; configured auth is shared with protected route groups. */
export const AuthRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const options = yield* loadOwnerHttpOptions;

    return Http.make(AppAuth, options).routes();
  }),
).pipe(Layer.provide(AuthLive));

/** Owner identity supplied only after durable session and subject authorization on the current request. */
export class CurrentOwner extends Context.Service<
  CurrentOwner,
  {
    readonly subjectId: "owner";
    readonly sessionId: typeof AppAuth.sessions.Session.Type.sessionId;
  }
>()("zupka/CurrentOwner") {}

const denied = (status: 401 | 403 | 503) =>
  HttpServerResponse.jsonUnsafe(
    {
      error: {
        401: "Authentication required",
        403: "Forbidden",
        503: "Authentication unavailable",
      }[status],
    },
    { status, headers: { "cache-control": "no-store" } },
  );

/** Durable owner/Origin/CSRF admission shared by protected groups and conditional private-image reads. */
export class OwnerGuard extends Context.Service<
  OwnerGuard,
  {
    /** Supply CurrentOwner only after current durable authority and request admission, or return a safe denial. */
    readonly protect: <E, R>(
      effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
    ) => Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      E,
      Exclude<R, CurrentOwner> | HttpServerRequest.HttpServerRequest
    >;
  }
>()("zupka/OwnerGuard") {}

/** Capture validated security options and the scoped auth service, never a request or session. */
export const OwnerGuardLive = Layer.effect(
  OwnerGuard,
  Effect.gen(function* () {
    const options = yield* loadOwnerHttpOptions;
    const api = yield* AppAuth;
    const http = Http.make(AppAuth, options);

    return OwnerGuard.of({
      protect: <E, R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
        http
          .withRequest(
            Effect.gen(function* () {
              const incoming = yield* HttpServerRequest.HttpServerRequest;
              const origin = incoming.headers.origin;

              // GET/HEAD may omit Origin for direct navigation/private images, but never trust a foreign one.
              if (origin !== undefined && origin !== options.origin) return denied(403);

              if (incoming.method === "OPTIONS") return denied(403);
              const result = yield* api.requireSession.pipe(Effect.result);

              if (Predicate.isTagged(result, "Failure")) {
                return denied(Schema.is(Auth.AuthenticationRequired)(result.failure) ? 401 : 503);
              }

              const session = result.success;

              if (session.subjectId !== "owner" || session.claims.role !== "owner")
                return denied(403);

              // Mutation admission is independent of body encoding (including future multipart uploads).
              if (incoming.method !== "GET" && incoming.method !== "HEAD") {
                const admission = yield* http.protect(Effect.void).pipe(Effect.result);

                if (Predicate.isTagged(admission, "Failure")) return denied(403);
              }

              return yield* effect.pipe(
                Effect.provideService(CurrentOwner, {
                  subjectId: "owner",
                  sessionId: session.sessionId,
                }),
              );
            }),
          )
          .pipe(
            Effect.provideService(AppAuth, api),
            Effect.catchTag("OperationHttpError", () => Effect.succeed(denied(403))),
            Effect.catchTag("OperationHttpConfigurationError", () => Effect.succeed(denied(503))),
            Effect.map((response) =>
              HttpServerResponse.setHeader(response, "cache-control", "no-store"),
            ),
          ),
    });
  }),
).pipe(Layer.provide(AuthLive));

const ownerMiddleware = HttpRouter.middleware<{ provides: CurrentOwner }>()(
  Effect.gen(function* () {
    const guard = yield* OwnerGuard;

    return (effect) => guard.protect(effect);
  }),
).layer.pipe(Layer.provide(OwnerGuardLive));

/** Mandatory route-group boundary for all management, upload, and private-image routes.
 * Apply once to each management route Layer; GET/HEAD require owner authorization, other methods also
 * require exact Origin plus Yielded CSRF admission before handlers run. Does not wrap public content.
 */
export function ownerRoutes<A, E, R>(routes: Layer.Layer<A, E, R>) {
  return routes.pipe(Layer.provide(ownerMiddleware));
}
