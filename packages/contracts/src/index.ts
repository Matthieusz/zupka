import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

/** Public response for the backend liveness endpoint. */
export const Health = Schema.Struct({
  status: Schema.Literal("ok"),
});

/** Decoded health response, shared by server and client. */
export interface Health extends Schema.Schema.Type<typeof Health> {}

/** Shared HTTP contract; all application routes live under /api. */
export const Api = HttpApi.make("zupka").add(
  HttpApiGroup.make("health").add(HttpApiEndpoint.get("get", "/api/health", { success: Health })),
);
