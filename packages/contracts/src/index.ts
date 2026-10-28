export * from "./entries.js";

export * from "./images.js";

export * from "./public-content.js";

import { AuthContract } from "@yielded/auth";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

/** Public response for the backend liveness endpoint. */
export const Health = Schema.Struct({
  status: Schema.Literal("ok"),
});

/** Decoded health response, shared by server and client. */
export interface Health extends Schema.Schema.Type<typeof Health> {}

const ownerAuth = AuthContract.make("zupka-owner", {
  basePath: "/api/auth",
  claims: Schema.Struct({ role: Schema.Literal("owner") }),
  actions: (sessions) => ({ signIn: AuthContract.passwordSignIn(sessions) }),
});

/** Only sign-in, session inspection, and logout are public auth operations.
 * Yielded defaults also include require/renew operations; those remain local-only here.
 */
export const OwnerAuth = {
  ...ownerAuth,
  actions: {
    signIn: ownerAuth.actions.signIn,
    getSession: ownerAuth.actions.getSession,
    signOut: ownerAuth.actions.signOut,
  },
};

/** Shared HTTP contract; all application routes live under /api. */
export const Api = HttpApi.make("zupka").add(
  HttpApiGroup.make("health").add(HttpApiEndpoint.get("get", "/api/health", { success: Health })),
);
