import { ConfigProvider, Effect, Predicate, Schema } from "effect";
import { migrateAuth } from "./auth.js";
import { contentDataMigrations } from "./content-data-migrations.js";
import {
  ContentConfigurationConflict,
  ContentMigrationConflict,
  migrateContent,
  migrateContentData,
} from "./content-storage.js";
import { DatabaseLive } from "./database.js";

// Explicit local operator command. Do not compose StorageLive here: adoption must follow conversion.
process.umask(0o077);

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const version = yield* Schema.decodeUnknownEffect(
      Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
    )(process.argv[2]);

    const migration = contentDataMigrations.find((item) => item.header.version === version);

    if (!migration || process.argv.length !== 3) {
      return yield* new ContentMigrationConflict({
        reason:
          "Usage: pnpm --filter @zupka/api content:migrate <configured-version>. Stop the service and back up storage first.",
      });
    }

    yield* Effect.gen(function* () {
      yield* migrateAuth;
      yield* migrateContent;
      yield* migrateContentData(migration);
    }).pipe(Effect.provide(DatabaseLive));
  }).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true }))),
    Effect.result,
  ),
);

if (Predicate.isTagged(result, "Failure")) {
  const failure = result.failure;

  const message = Schema.is(ContentMigrationConflict)(failure)
    ? failure.reason
    : Schema.is(ContentConfigurationConflict)(failure)
      ? `${failure.typeId}: ${failure.reason}`
      : "Migration failed. Check the conversion, source configuration, version, and storage access; no partial conversion was committed.";

  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    "Content migration committed. Check the configured definitions before restarting the service.\n",
  );
}
