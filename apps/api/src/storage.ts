import { Effect, Layer } from "effect";
import { migrateAuth } from "./auth.js";
import { loadContentConfiguration } from "./content-config.js";
import { acceptContentConfiguration, migrateContent } from "./content-storage.js";
import { DatabaseLive } from "./database.js";

/** Production initialization: upgrade owner/content DDL, then atomically accept compatible definitions. */
export const initializeStorage = Effect.gen(function* () {
  yield* migrateAuth;
  yield* migrateContent;
  yield* acceptContentConfiguration(yield* loadContentConfiguration);
});

/** One initialized SQLite scope shared by all server routes and local owner commands. */
export const StorageLive = Layer.effectDiscard(initializeStorage).pipe(
  Layer.provideMerge(DatabaseLive),
);
