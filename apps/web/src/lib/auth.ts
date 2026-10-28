import { Client } from "@yielded/auth";
import { OwnerAuth } from "@zupka/contracts";
import { Effect } from "effect";

/** Reads the current cookie session using Yielded Auth's schema-decoding Effect client. */
export const loadSession = Effect.fn("Web.loadSession")(function* () {
  const client = Client.make(OwnerAuth, { baseUrl: globalThis.location.origin });

  return yield* Effect.gen(function* () {
    const api = yield* client;

    return yield* api.auth.getSession();
  }).pipe(Effect.provide(client.layerFetch));
});

/** Attempts password sign-in once; credentials are sent in the request body, never stored. */
export const signIn = Effect.fn("Web.signIn")(function* (email: string, password: string) {
  const client = Client.make(OwnerAuth, { baseUrl: globalThis.location.origin });

  return yield* Effect.gen(function* () {
    const api = yield* client;

    return yield* api.auth.signIn({ email, password });
  }).pipe(Effect.provide(client.layerFetch));
});

/** Revokes the cookie session and clears the browser credential through the auth client. */
export const signOut = Effect.fn("Web.signOut")(function* () {
  const client = Client.make(OwnerAuth, { baseUrl: globalThis.location.origin });

  return yield* Effect.gen(function* () {
    const api = yield* client;

    return yield* api.auth.signOut();
  }).pipe(Effect.provide(client.layerFetch));
});
