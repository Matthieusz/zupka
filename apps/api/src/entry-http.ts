import { EntriesApi, EntryUnavailable } from "@zupka/contracts";
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  EntryStorageFailure,
  createEntry,
  deleteEntry,
  entryTypes,
  getEntry,
  listEntries,
  publishEntry,
  unpublishEntry,
  saveEntry,
} from "./entries.js";
import { ownerRoutes } from "./owner-http.js";

const transport = <A, E, R>(effect: Effect.Effect<A, E | EntryStorageFailure, R>) =>
  effect.pipe(Effect.catchTag("EntryStorageFailure", () => Effect.fail(new EntryUnavailable({}))));

const handlers = HttpApiBuilder.group(EntriesApi, "entries", (group) =>
  group
    .handle("types", () => transport(entryTypes))
    .handle("create", ({ params, payload }) => transport(createEntry(params.typeId, payload)))
    .handle("get", ({ params }) => transport(getEntry(params.typeId, params.entryId)))
    .handle("list", ({ params, query }) => transport(listEntries(params.typeId, query)))
    .handle("save", ({ params, payload }) =>
      transport(saveEntry(params.typeId, params.entryId, payload)),
    )
    .handle("publish", ({ params, payload }) =>
      transport(publishEntry(params.typeId, params.entryId, payload)),
    )
    .handle("unpublish", ({ params, payload }) =>
      transport(unpublishEntry(params.typeId, params.entryId, payload)),
    )
    .handle("delete", ({ params, payload }) =>
      transport(deleteEntry(params.typeId, params.entryId, payload.revision)),
    ),
);

/** Thin schema-decoding management routes; owner/Origin/CSRF checks run before handlers. */
export const EntryRoutes = ownerRoutes(
  HttpApiBuilder.layer(EntriesApi).pipe(Layer.provide(handlers)),
);
