import { Api, Health } from "@zupka/contracts";
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";

const HealthLive = HttpApiBuilder.group(Api, "health", (handlers) =>
  handlers.handle("get", () => Effect.succeed(Health.make({ status: "ok" }))),
);

/** Registers the API routes; the composition root provides HTTP platform services. */
export const ApiLive = HttpApiBuilder.layer(Api).pipe(Layer.provide(HealthLive));
