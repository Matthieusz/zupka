import { NodeCrypto } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Auth, Operations, Password, Schema as AuthSchema, Sessions } from "@yielded/auth";
import { AuthPersistence } from "@yielded/auth-persistence";
import * as KdfAdmission from "@yielded/crypto/KdfAdmission";
import * as NodeBackend from "@yielded/crypto/platform-node";
import { Effect, Layer, Predicate, Redacted, Schema } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient } from "effect/sql";
import { expect, it } from "vite-plus/test";

const auth = Auth.make("sqlite-compatibility", {
  claims: Schema.Struct({}),
  defaultStrategy: "password",
  strategies: { password: Password.make() },
  sessions: Sessions.stateful(),
});

const subjects = AuthPersistence.table({
  name: "subjects",
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
  maximumAgeMillis: 60_000,
});

const persistence = AuthPersistence.make(auth);

const storage = persistence.managed({
  prefix: "auth",
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

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

it("signs in with a SQLite-backed password and rejects sessions after an authority revision change", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // @effect-diagnostics-next-line unstableApiUsage:off -- This test verifies the pinned SQLite driver.
        const sql = yield* SqliteClient.make({ filename: ":memory:" });

        for (const table of [subjects, ...Object.values(storage.schema)]) {
          const columns = Object.values(table.columns).map(
            ({ options }) =>
              `${quote(options.name)} ${options.type === "text" ? "text" : "integer"}${options.nullable ? "" : " not null"}`,
          );

          const keys = table.unique.map((key) => {
            const names = key.map((name) => {
              const column = table.columns[name];

              if (column === undefined) throw new Error(`Missing column: ${name}`);

              return quote(column.options.name);
            });

            return `unique (${names.join(", ")})`;
          });

          yield* sql.unsafe(
            `create table ${quote(table.name)} (${[...columns, ...keys].join(", ")})`,
          );
        }

        yield* sql`insert into subjects values ('owner', 1, 'revision-1')`;

        const services = yield* Layer.build(
          persistence.layer.pipe(
            Layer.provide(persistence.Config.layer(storage)),
            // @effect-diagnostics-next-line unstableApiUsage:off -- Auth persistence requires the Effect SQL client.
            Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
            // @effect-diagnostics-next-line unstableApiUsage:off -- The adapter requires platform crypto.
            Layer.provide(NodeCrypto.layer),
          ),
        );

        const authority = yield* Sessions.AuthenticationAuthority.pipe(Effect.provide(services));
        const result = yield* authority.capture(AuthSchema.SubjectId.make("owner"), []);

        expect(result.revision.securityRevision).toBe("revision-1");

        const hashing = Password.PasswordHashing.layer(
          Password.defaultScryptPasswordHashingConfig,
        ).pipe(
          Layer.provide(NodeBackend.layer().pipe(Layer.provideMerge(KdfAdmission.layer()))),
          // @effect-diagnostics-next-line unstableApiUsage:off -- Password entropy uses platform crypto.
          Layer.provide(NodeCrypto.layer),
        );

        const runtime = yield* Layer.build(
          auth.layer.pipe(
            Layer.provide(Layer.succeedContext(services)),
            Layer.provide(hashing),
            // @effect-diagnostics-next-line unstableApiUsage:off -- Sessions require platform crypto.
            Layer.provide(NodeCrypto.layer),
            Layer.provide(
              Layer.succeed(auth.strategies.password.SessionClaims, {
                resolve: () => Effect.succeed({}),
              }),
            ),
          ),
        );

        const hasher = yield* Password.PasswordHashing.pipe(Effect.provide(hashing));
        const verifier = yield* hasher.hash(Redacted.make("a long test password"));
        const moduleId = auth.strategies.password.persistence.moduleId;

        yield* sql`insert into auth_identifiers
          (namespace, value, subject_id, revision, active)
          values ('email', 'owner@example.invalid', 'owner', 'revision-1', 1)`;
        yield* sql`insert into auth_credentials
          (credential_id, subject_id, revision, active)
          values ('owner-password', 'owner', 'revision-1', 1)`;
        yield* sql`insert into auth_passwords
          (module_id, subject_id, credential_id, credential_revision,
           verifier_version, verifier, normalization)
          values (${moduleId}, 'owner', 'owner-password', 'revision-1',
            'revision-1', ${Redacted.value(verifier)}, 'none')`;

        const instance = yield* auth.pipe(Effect.provide(runtime));
        let credential: Redacted.Redacted<string> | undefined;

        const request = Auth.AuthRequest.of({
          invocation: Operations.guest,
          credentials: {},
          credentialCommandSink: (commands) =>
            Effect.sync(() => {
              for (const command of commands) {
                if (Predicate.isTagged(command, "Issue") && command.slot === "session") {
                  credential = command.credential;
                }
              }
            }),
        });

        const signedIn = yield* instance
          .signIn({
            email: "owner@example.invalid",
            password: "a long test password",
          })
          .pipe(Effect.provideService(Auth.AuthRequest, request));

        expect(Predicate.isTagged(signedIn, "Authenticated")).toBe(true);

        if (credential === undefined) throw new Error("Session was not issued");

        expect((yield* instance.verifySession(credential)).subjectId).toBe("owner");
        yield* sql`update subjects set revision = 'revision-2' where id = 'owner'`;
        expect((yield* instance.verifySession(credential).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        // @effect-diagnostics-next-line unstableApiUsage:off -- The SQLite driver requires reactivity.
      }).pipe(Effect.provide(Reactivity.layer)),
    ),
  );
});
