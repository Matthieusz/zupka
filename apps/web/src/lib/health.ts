import { Api } from "@zupka/contracts";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";

/** Fetches and schema-decodes liveness; cancellation aborts the HTTP request. */
export const loadHealth = Effect.fn("Web.loadHealth")(function* () {
  const client = yield* HttpApiClient.make(Api);

  return yield* client.health.get({});
}, Effect.provide(FetchHttpClient.layer));
