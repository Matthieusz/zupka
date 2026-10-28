import { NodeCrypto } from "@effect/platform-node";
import { OwnerAuth } from "@zupka/contracts";
import { Auth, Password, Schema as AuthSchema, Sessions } from "@yielded/auth";
import { AuthPersistence } from "@yielded/auth-persistence";
import * as KdfAdmission from "@yielded/crypto/KdfAdmission";
import * as NodeBackend from "@yielded/crypto/platform-node";
import { Effect, Layer, Redacted, Schema } from "effect";
import { Migrator, SqlClient } from "effect/sql";

/** Persistent owner password authentication with revocable stateful sessions. */
export const AppAuth = Auth.make(OwnerAuth, {
  defaultStrategy: "password",
  strategies: {
    password: Password.make({
      policy: {
        ...Password.defaultPasswordMethodPolicy,
        requireImmediateInvalidation: true,
        attempts: {
          identifier: { limit: 10, windowMillis: 900_000 },
          subject: { limit: 10, windowMillis: 900_000 },
          action: { limit: 30, windowMillis: 60_000 },
        },
      },
    }),
  },
  sessions: Sessions.stateful({
    idleTimeout: "12 hours",
    maxAge: "7 days",
    renewAfter: "6 hours",
    maximumIssuedAge: "30 days",
  }),
});

const subjects = AuthPersistence.table({
  name: "owners",
  columns: {
    id: { name: "id", type: "text" },
    active: { name: "active", type: "boolean" },
    revision: { name: "revision", type: "text" },
  },
  unique: [["id"]],
});

const requirement = Sessions.AuthenticationRequirement.make({
  alternatives: [
    {
      factors: ["knowledge"],
      minimumCredentials: 1,
      userVerified: false,
      phishingResistant: false,
    },
  ],
  maximumAgeMillis: 300_000,
});

const persistence = AuthPersistence.make(AppAuth);

const storage = persistence.managed({
  prefix: "owner_auth",
  subjects: {
    table: subjects,
    id: "id",
    status: "active",
    activeValue: true,
    securityRevision: "revision",
    idCodec: AuthSchema.SubjectId,
    requirements: () => Effect.succeed(requirement),
  },
});

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

/** Initial versioned auth schema; the application owns its migration history. */
// @effect-diagnostics-next-line unstableApiUsage:off -- Pinned SQL migrator owns version tracking.
export const migrateAuth = Migrator.make({})({
  table: "owner_migrations",
  // @effect-diagnostics-next-line unstableApiUsage:off -- Application-owned versioned migrations.
  loader: Migrator.fromRecord({
    "0001_owner_auth": Effect.gen(function* () {
      // @effect-diagnostics-next-line unstableApiUsage:off -- Migrations use the shared connection.
      const sql = yield* SqlClient.SqlClient;

      for (const table of [subjects, ...Object.values(storage.schema)]) {
        const columns = Object.values(table.columns).map(
          ({ options }) =>
            `${quote(options.name)} ${options.type === "text" ? "text" : "integer"}${options.nullable ? "" : " not null"}`,
        );

        const keys = table.unique.map((key) => {
          const names = key.map((name) => {
            const column = table.columns[name];

            if (column === undefined) throw new Error("Invalid auth table definition");

            return quote(column.options.name);
          });

          return `unique (${names.join(", ")})`;
        });

        yield* sql.unsafe(
          `create table ${quote(table.name)} (${[...columns, ...keys].join(", ")})`,
        );
      }

      yield* sql`create unique index one_owner on owners ((1))`;
    }),
  }),
});

/** Native bounded scrypt hashing; plaintext passwords remain redacted until hashing. */
export const HashingLive = Password.PasswordHashing.layer({
  ...Password.defaultScryptPasswordHashingConfig,
  maximumPasswordBytes: 4096,
}).pipe(
  Layer.provide(
    NodeBackend.layer().pipe(
      Layer.provideMerge(
        KdfAdmission.layer({
          concurrency: 1,
          maxQueued: 2,
          maxWaitMilliseconds: 1000,
        }),
      ),
    ),
  ),

  // @effect-diagnostics-next-line unstableApiUsage:off -- Entropy comes from Node Crypto.
  Layer.provide(NodeCrypto.layer),
);

const stores = persistence.layer.pipe(Layer.provide(persistence.Config.layer(storage)));

/** Auth layer requires one migrated SQL client; it never installs request-local authority. */
export const AuthLive = AppAuth.layer.pipe(
  Layer.provide(stores),
  Layer.provide(HashingLive),
  Layer.provide(
    Layer.succeed(AppAuth.strategies.password.SessionClaims, {
      resolve: ({ subjectId }) =>
        subjectId === "owner"
          ? Effect.succeed({ role: "owner" as const })
          : Effect.fail(Password.PasswordUnavailable.make({})),
    }),
  ),
  // @effect-diagnostics-next-line unstableApiUsage:off -- Sessions and persistence require platform entropy.
  Layer.provide(NodeCrypto.layer),
);

/** Safe operator-facing provisioning/recovery failure, with no password or SQL details. */
export class OwnerCommandError extends Schema.TaggedError<
  OwnerCommandError,
  { readonly brand: unique symbol }
>()("OwnerCommandError", {
  message: Schema.String,
}) {}

/** Local-only creation or recovery in one transaction; recovery revokes all prior authority. */
export const setOwnerPassword = Effect.fn("Owner.setPassword")(function* (
  mode: "create" | "recover",
  emailInput: string,
  password: Redacted.Redacted<string>,
) {
  const email = yield* Schema.decodeEffect(AuthSchema.Email)(emailInput).pipe(
    Effect.mapError(() => new OwnerCommandError({ message: "Enter a valid email address." })),
  );

  yield* Schema.decodeEffect(Schema.String.check(Schema.isMinLength(12), Schema.isMaxLength(1024)))(
    Redacted.value(password),
  ).pipe(
    Effect.mapError(
      () => new OwnerCommandError({ message: "Use a password of 12–1024 characters." }),
    ),
  );
  const hashing = yield* Password.PasswordHashing;
  const verifier = yield* hashing.hash(password);
  // @effect-diagnostics-next-line unstableApiUsage:off -- Operator writes share an atomic SQL transaction.
  const sql = yield* SqlClient.SqlClient;
  const revision = crypto.randomUUID();
  const moduleId = AppAuth.strategies.password.persistence.moduleId;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const existing = yield* sql`select id from owners`;

      if (mode === "create") {
        if (existing.length !== 0)
          return yield* new OwnerCommandError({
            message: "An owner already exists. Use owner:recover.",
          });
        yield* sql`insert into owners values ('owner', 1, ${revision})`;
        yield* sql`insert into owner_auth_identifiers (namespace, value, subject_id, revision, active)
        values ('email', ${email}, 'owner', ${revision}, 1)`;
        yield* sql`insert into owner_auth_credentials (credential_id, subject_id, revision, active)
        values ('owner-password', 'owner', ${revision}, 1)`;
        yield* sql`insert into owner_auth_passwords
        (module_id, subject_id, credential_id, credential_revision, verifier_version, verifier, normalization)
        values (${moduleId}, 'owner', 'owner-password', ${revision}, ${revision}, ${Redacted.value(verifier)}, 'none')`;
      } else {
        const identifier =
          yield* sql`select subject_id from owner_auth_identifiers where value = ${email} and namespace = 'email'`;

        if (existing.length !== 1 || identifier.length !== 1)
          return yield* new OwnerCommandError({
            message: "No matching owner. Create the owner first or check the email.",
          });
        yield* sql`update owners set revision = ${revision}`;
        yield* sql`update owner_auth_credentials set revision = ${revision}`;
        yield* sql`update owner_auth_passwords set credential_revision = ${revision}, verifier_version = ${revision}, verifier = ${Redacted.value(verifier)}, normalization = 'none'`;
        yield* sql`delete from owner_auth_sessions`;
      }
    }),
  );
});
