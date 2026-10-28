// @effect-diagnostics unstableApiUsage:off -- This scoped adapter owns the pinned SQLite driver and reactivity APIs.
import { resolve, sep } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Config, Context, Effect, Layer, Schedule, Schema } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient } from "effect/sql";
import { LockTimeoutError, SqlError } from "effect/sql/SqlError";

const diskPath = Schema.String.check(
  Schema.makeFilter(
    (path) =>
      path.trim().length > 0 &&
      !path.includes("\0") &&
      path !== ":memory:" &&
      !path.startsWith("file:"),
  ),
);

const storagePathInput = Schema.Struct({ databasePath: diskPath, uploadsPath: diskPath });

/** Normalized runtime storage locations; database files must never live in the upload directory. */
export const StoragePaths = storagePathInput.check(
  Schema.makeFilter(
    ({ databasePath, uploadsPath }) =>
      databasePath !== uploadsPath &&
      !databasePath.startsWith(uploadsPath.endsWith(sep) ? uploadsPath : uploadsPath + sep),
  ),
);

/** Invalid or overlapping storage locations fail before opening SQLite. */
export class InvalidStorageConfiguration extends Schema.TaggedError<
  InvalidStorageConfiguration,
  { readonly brand: unique symbol }
>()("InvalidStorageConfiguration", { message: Schema.String }) {}

/** Read validated filesystem paths once at the runtime boundary; relative paths resolve against cwd. */
export const loadStoragePaths = Effect.gen(function* () {
  const databasePath = yield* Config.String("DATABASE_PATH").pipe(
    Config.withDefault("zupka.sqlite"),
  );

  const uploadsPath = yield* Config.String("UPLOADS_PATH").pipe(Config.withDefault("uploads"));

  // Decode before path normalization so ephemeral names and explicit blank values cannot become disk paths.
  const paths = yield* Schema.decodeEffect(storagePathInput)({ databasePath, uploadsPath }).pipe(
    Effect.mapError(
      () =>
        new InvalidStorageConfiguration({
          message: "Storage paths must be nonempty disk paths, not SQLite memory names or URIs.",
        }),
    ),
  );

  return yield* Schema.decodeEffect(StoragePaths)({
    databasePath: resolve(paths.databasePath),
    uploadsPath: resolve(paths.uploadsPath),
  }).pipe(
    Effect.mapError(
      () =>
        new InvalidStorageConfiguration({ message: "DATABASE_PATH must be outside UPLOADS_PATH." }),
    ),
  );
});

/** Storage paths owned by the same scope as the single SQLite connection. */
export class StorageConfiguration extends Context.Service<
  StorageConfiguration,
  typeof StoragePaths.Type
>()("zupka/StorageConfiguration") {}

/** Run a database-only/filesystem-check transaction with bounded, cooperative lock acquisition.
 * Retried SQL failures have been rolled back by the driver; never wrap external/network side effects.
 * No validation/conflict/other SQL failure or committed mutation is retried. The final lock failure remains typed.
 */
export function withDatabaseTransaction<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return yield* sql.withTransaction(effect).pipe(
      Effect.retry({
        while: (error) => Schema.is(SqlError)(error) && Schema.is(LockTimeoutError)(error.reason),
        schedule: Schedule.spaced("10 millis").pipe(Schedule.upTo({ times: 100 })),
      }),
    );
  });
}

/** One scoped WAL connection for auth, content, migrations, and operator commands.
 * Foreign keys are explicitly enabled; parent directories must already exist.
 */
export const DatabaseLive = Layer.effectContext(
  Effect.gen(function* () {
    const paths = yield* loadStoragePaths;
    // Native busy waits block the event loop, starving file checks held by another local transaction.
    // Content workflows instead retry rolled-back transactions via withDatabaseTransaction.
    const sql = yield* SqliteClient.make({ filename: paths.databasePath, busyTimeout: 0 });
    yield* sql`pragma foreign_keys = ON`;

    return Context.make(SqlClient.SqlClient, sql).pipe(
      Context.add(SqliteClient.SqliteClient, sql),
      Context.add(StorageConfiguration, paths),
    );
  }),
).pipe(Layer.provide(Reactivity.layer));
