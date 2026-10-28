import { EntriesApi, type AdminEntry, type PublicationState } from "@zupka/contracts";
import { Effect, Match, Schema } from "effect";
import { FetchHttpClient, HttpClientError } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { runEffect } from "./effect.js";

/** Fixed management page size; included in each list cache key and request. */
export const ENTRY_PAGE_SIZE = 20;

/** Safe client-side failure classification; raw transport errors never reach UI copy. */
export class AdminReadError extends Schema.TaggedError<
  AdminReadError,
  { readonly brand: unique symbol }
>()("AdminReadError", {
  reason: Schema.Literals(["session-expired", "forbidden", "unavailable"]),
  cause: Schema.Defect(),
}) {}

// HTTP contract failures and uncontracted owner-guard responses meet at this boundary.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
const readError = (error: unknown) => {
  const status = HttpClientError.isHttpClientError(error) ? error.response?.status : undefined;

  return Match.value(status).pipe(
    Match.when(401, () => new AdminReadError({ reason: "session-expired", cause: error })),
    Match.when(403, () => new AdminReadError({ reason: "forbidden", cause: error })),
    Match.orElse(() => new AdminReadError({ reason: "unavailable", cause: error })),
  );
};

/** Reads the safe, schema-decoded deployment definitions, never server configuration imports. */
export const loadContentTypes = Effect.fn("Web.loadContentTypes")(
  function* () {
    const api = yield* HttpApiClient.make(EntriesApi);

    return yield* api.entries.types({});
  },
  Effect.provide(FetchHttpClient.layer),
  Effect.mapError(readError),
);

/** All list parameters are explicit so callers can use the same values in cache identity. */
export interface EntryFilters {
  readonly search: string;
  readonly state: typeof PublicationState.Type | "all";
  readonly offset: number;
}

/** Reads one bounded, schema-decoded owner page; no writes, retries, or public DTOs. */
export const loadEntries = Effect.fn("Web.loadEntries")(
  function* (typeId: typeof AdminEntry.Type.typeId, filters: EntryFilters) {
    const api = yield* HttpApiClient.make(EntriesApi);
    const query = { search: filters.search, limit: ENTRY_PAGE_SIZE, offset: filters.offset };

    if (filters.state === "all") return yield* api.entries.list({ params: { typeId }, query });

    return yield* api.entries.list({
      params: { typeId },
      query: { ...query, state: filters.state },
    });
  },
  Effect.provide(FetchHttpClient.layer),
  Effect.mapError(readError),
);

/** Runs a Query-owned request; a confirmed 401 first revokes protected UI/cache access. */
export async function readAdmin<A>(
  program: Effect.Effect<A, AdminReadError>,
  signal: AbortSignal,
  onSessionLost: () => Promise<void>,
): Promise<A> {
  try {
    return await runEffect(program, signal);
  } catch (error) {
    signal.throwIfAborted();

    if (Schema.is(AdminReadError)(error) && error.reason === "session-expired") {
      await onSessionLost();
    }

    throw error;
  }
}
