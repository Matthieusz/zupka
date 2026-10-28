// @effect-diagnostics unstableApiUsage:off -- These tests inspect the real production SQLite connection.
import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeHttpServer } from "@effect/platform-node";
import { Password } from "@yielded/auth";
import { Clock, ConfigProvider, Effect, Layer, Predicate, Redacted } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { expect, it } from "vite-plus/test";
import { HashingLive, setOwnerPassword } from "./auth.js";
import {
  AuthRoutes,
  CurrentOwner,
  loadOwnerHttpOptions,
  ownerRoutes,
  OwnerSecurityConfigurationError,
} from "./owner-http.js";
import { StorageLive } from "./storage.js";

const password = "a private owner password";

const email = "owner@example.invalid";

async function fixture(origin = "http://localhost:5173", mode = "test") {
  const directory = await mkdtemp(join(tmpdir(), "zupka-owner-security-"));
  let now = Date.UTC(2026, 0, 1);
  let writes = 0;
  const liveClock = await Effect.runPromise(Effect.service(Clock.Clock));

  const clock: Clock.Clock = {
    monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: liveClock.monotonicTimeNanos,
    sleep: (duration) => liveClock.sleep(duration),
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
  };

  // Only limiter time is virtual: Yielded persistence deliberately uses SQLite engine time
  // for authentication freshness, so changing the application clock would invalidate real logins.
  const limiter = Layer.effect(
    Password.PasswordAttemptLimiter,
    Effect.gen(function* () {
      const real = yield* Password.PasswordAttemptLimiter;

      return Password.PasswordAttemptLimiter.of({
        check: (input) => real.check(input).pipe(Effect.provideService(Clock.Clock, clock)),
      });
    }),
  ).pipe(Layer.provide(Password.PasswordAttemptLimiter.layer));

  const config = ConfigProvider.layer(
    ConfigProvider.fromUnknown(
      {
        DATABASE_PATH: join(directory, "owner.sqlite"),
        UPLOADS_PATH: join(directory, "images"),
        AUTH_ORIGIN: origin,
        NODE_ENV: mode,
      },
      { preserveEmptyStrings: true },
    ),
  );

  const services = Layer.merge(StorageLive, HashingLive).pipe(Layer.provide(config));

  const command = (operation: "create" | "recover", value = password, address = email) =>
    Effect.runPromise(
      setOwnerPassword(operation, address, Redacted.make(value)).pipe(Effect.provide(services)),
    );

  const read = Effect.gen(function* () {
    const owner = yield* CurrentOwner;

    return HttpServerResponse.jsonUnsafe({ subjectId: owner.subjectId });
  });

  const write = Effect.sync(() => {
    writes += 1;

    return HttpServerResponse.jsonUnsafe({ saved: true });
  });

  const protectedRoutes = ownerRoutes(
    HttpRouter.addAll([
      HttpRouter.route("GET", "/api/admin/check", read),
      HttpRouter.route("GET", "/api/admin/images/private", read),
      HttpRouter.route("HEAD", "/api/admin/images/private", read),
      HttpRouter.route("POST", "/api/admin/images", write),
      HttpRouter.route("DELETE", "/api/admin/check", write),
    ]),
  );

  const app = HttpRouter.toWebHandler(
    Layer.merge(AuthRoutes, protectedRoutes).pipe(
      Layer.provide(StorageLive),
      Layer.provide(config),
      Layer.provide(limiter),
      Layer.provide(NodeHttpServer.layerHttpServices),
    ),
    { disableLogger: true },
  );

  const auth = (
    action: string,
    payload: { readonly email?: string; readonly password?: string } = {},
    cookie = "",
    headers = {},
  ) =>
    app.handler(
      new Request(`${origin}/api/auth/${action}`, {
        method: "POST",
        headers: {
          origin,
          "x-effect-auth-csrf": "1",
          "content-type": "application/json",
          cookie,
          ...headers,
        },
        body: JSON.stringify({ payload }),
      }),
    );

  const admin = (path: string, method = "GET", cookie = "", headers = {}, body?: string) => {
    const init: RequestInit = { method, headers: { cookie, ...headers } };

    if (body !== undefined) init.body = body;

    return app.handler(new Request(`${origin}${path}`, init));
  };

  return {
    app,
    auth,
    admin,
    command,
    writes: () => writes,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    inspect: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return {
            owners: yield* sql`select * from owners`,
            passwords: yield* sql`select verifier from owner_auth_passwords`,
            sessions: yield* sql`select * from owner_auth_sessions`,
          };
        }).pipe(Effect.provide(services)),
      ),
    setRecoveryFailure: (enabled: boolean) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          if (enabled) {
            yield* sql`create trigger fail_recovery before delete on owner_auth_sessions
          begin select raise(abort, 'Injected storage failure'); end`;
          } else {
            yield* sql`drop trigger fail_recovery`;
          }
        }).pipe(Effect.provide(services)),
      ),
    corruptSubject: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`update owners set id = 'intruder'`;
              yield* sql`update owner_auth_identifiers set subject_id = 'intruder'`;
              yield* sql`update owner_auth_credentials set subject_id = 'intruder'`;
              yield* sql`update owner_auth_passwords set subject_id = 'intruder'`;
            }),
          );
        }).pipe(Effect.provide(services)),
      ),
    close: async () => {
      await app.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function sessionCookie(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

it("requires durable owner authority for management and private images, including HEAD", async () => {
  const test = await fixture();

  try {
    await test.command("create");

    for (const [path, method] of [
      ["/api/admin/check", "GET"],
      ["/api/admin/images/private", "GET"],
      ["/api/admin/images/private", "HEAD"],
      ["/api/admin/images", "POST"],
    ]) {
      const response = await test.admin(path ?? "", method);
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }

    expect((await test.admin("/api/admin/check", "GET", "effect-auth-session=forged")).status).toBe(
      401,
    );
    expect(
      (await test.admin("/api/admin/check", "GET", "", { authorization: "Bearer owner" })).status,
    ).toBe(401);
    const signedIn = await test.auth("signIn", { email, password });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    const cookie = sessionCookie(signedIn);
    expect(cookie).not.toBe("");
    const allowed = await test.admin("/api/admin/check", "GET", cookie);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ subjectId: "owner" });
    expect((await test.admin("/api/admin/images/private", "HEAD", cookie)).status).toBe(200);
    expect(
      (await test.admin("/api/admin/check", "GET", cookie, { origin: "https://evil.invalid" }))
        .status,
    ).toBe(403);
    expect(
      (
        await test.admin("/api/admin/images/private", "HEAD", cookie, {
          origin: "https://evil.invalid",
        })
      ).status,
    ).toBe(403);
  } finally {
    await test.close();
  }
});

it("admits multipart/custom management writes only after exact Origin and CSRF checks", async () => {
  const test = await fixture();

  try {
    await test.command("create");
    const cookie = sessionCookie(await test.auth("signIn", { email, password }));

    for (const headers of [
      {},
      { origin: "http://localhost:5173" },
      { "x-effect-auth-csrf": "1" },
      { origin: "https://evil.invalid", "x-effect-auth-csrf": "1" },
      { origin: "null", "x-effect-auth-csrf": "1" },
      { origin: "http://localhost:5173", "x-effect-auth-csrf": "wrong" },
      {
        origin: "https://evil.invalid",
        "x-effect-auth-csrf": "1",
        "x-forwarded-host": "localhost:5173",
        "x-forwarded-proto": "http",
      },
    ]) {
      const response = await test.admin(
        "/api/admin/images",
        "POST",
        cookie,
        headers,
        "pretend upload",
      );

      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }

    expect(test.writes()).toBe(0);

    const allowed = await test.admin(
      "/api/admin/images",
      "POST",
      cookie,
      {
        origin: "http://localhost:5173",
        "x-effect-auth-csrf": "1",
        "content-type": "multipart/form-data; boundary=test",
      },
      "--test--",
    );

    expect(allowed.status).toBe(200);
    expect(test.writes()).toBe(1);
    expect(
      (
        await test.admin("/api/admin/check", "DELETE", cookie, {
          origin: "http://localhost:5173",
          "x-effect-auth-csrf": "1",
        })
      ).status,
    ).toBe(200);
    expect(test.writes()).toBe(2);
    await test.auth("signOut", {}, cookie);
    expect((await test.admin("/api/admin/check", "GET", cookie)).status).toBe(401);
    expect(
      (
        await test.admin("/api/admin/images", "POST", cookie, {
          origin: "http://localhost:5173",
          "x-effect-auth-csrf": "1",
        })
      ).status,
    ).toBe(401);
    expect(test.writes()).toBe(2);
  } finally {
    await test.close();
  }
});

it("uses Secure host-only cookies in production and exposes no provisioning or extra session routes", async () => {
  const test = await fixture("https://cms.example.invalid", "production");

  try {
    await test.command("create");
    const response = await test.auth("signIn", { email, password });
    expect(response.status).toBe(200);
    const cookies = response.headers.get("set-cookie") ?? "";
    expect(cookies).toContain("__Host-");
    expect(cookies).toContain("Secure");
    expect(cookies).toContain("HttpOnly");
    expect(cookies).toContain("SameSite=Strict");
    expect(cookies).toContain("Path=/");
    expect(cookies).not.toMatch(/Domain=/i);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain(password);

    for (const action of [
      "register",
      "signUp",
      "setup",
      "requestReset",
      "resetPassword",
      "recover",
      "createOwner",
      "renewSession",
      "requireSession",
    ]) {
      expect((await test.auth(action)).status).toBe(404);
    }

    expect(
      (await test.app.handler(new Request("https://cms.example.invalid/api/auth/requireSession")))
        .status,
    ).toBe(404);
    expect((await test.admin("/api/admin/check", "GET", sessionCookie(response))).status).toBe(200);
    const state = await test.inspect();
    expect(JSON.stringify(state.passwords)).not.toContain(password);
    expect(JSON.stringify(state.passwords)).toContain("$scrypt$");
  } finally {
    await test.close();
  }
});

it("rejects malformed requests, oversized bodies and passwords without exposing supplied secrets", async () => {
  const test = await fixture();

  try {
    await test.command("create");

    for (const headers of [
      { origin: "https://evil.invalid" },
      { origin: "" },
      { "x-effect-auth-csrf": "" },
      { "content-type": "text/plain" },
    ]) {
      const response = await test.auth("signIn", { email, password }, "", headers);
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).not.toContain(password);
    }

    const tooLarge = await test.auth("signIn", { email, password: "x".repeat(20_000) });
    expect(tooLarge.status).toBe(413);
    const oversizedPassword = await test.auth("signIn", { email, password: "secret".repeat(800) });
    expect(oversizedPassword.status).not.toBe(200);
    expect(oversizedPassword.headers.get("set-cookie")).toBeNull();
    const text = await oversizedPassword.text();
    expect(text).not.toContain("secret".repeat(800));
    expect(text).not.toContain(email);
    const wrong = await test.auth("signIn", { email, password: "wrong private password" });

    const unknown = await test.auth("signIn", {
      email: "missing@example.invalid",
      password: "wrong private password",
    });

    expect(wrong.status).toBe(unknown.status);
    expect(await wrong.text()).toBe(await unknown.text());
  } finally {
    await test.close();
  }
});

it("rate-limits owner attempts and recovers one token only when the clock advances", async () => {
  const test = await fixture();

  try {
    await test.command("create");

    for (let count = 0; count < 10; count += 1) {
      expect((await test.auth("signIn", { email, password: "wrong password" })).status).not.toBe(
        200,
      );
    }

    const blocked = await test.auth("signIn", { email, password });
    expect(blocked.status).not.toBe(200);
    expect(blocked.headers.get("set-cookie")).toBeNull();
    expect(await blocked.text()).toContain("PasswordRejected");
    test.advance(90_000);
    expect((await test.auth("signIn", { email, password })).status).toBe(200);
    expect((await test.auth("signIn", { email, password })).status).not.toBe(200);
  } finally {
    await test.close();
  }
});

it("applies the global action budget even when attackers rotate unknown identifiers", async () => {
  const test = await fixture();

  try {
    await test.command("create");

    for (let count = 0; count < 30; count += 1) {
      expect(
        (
          await test.auth("signIn", {
            email: `missing-${count}@example.invalid`,
            password: "wrong password",
          })
        ).status,
      ).not.toBe(200);
    }

    expect((await test.auth("signIn", { email, password })).status).not.toBe(200);
    test.advance(2000);
    expect((await test.auth("signIn", { email, password })).status).toBe(200);
  } finally {
    await test.close();
  }
}, 15_000);

it("recovers the password atomically, invalidates every cookie, and rejects a second owner", async () => {
  const test = await fixture();

  try {
    await test.command("create");
    const first = sessionCookie(await test.auth("signIn", { email, password }));
    const second = sessionCookie(await test.auth("signIn", { email, password }));

    await expect(test.command("create", "second owner's password")).rejects.toThrow();
    const before = await test.inspect();
    expect(before.owners).toHaveLength(1);
    expect(before.sessions).toHaveLength(2);
    await expect(
      test.command("recover", "new owner password", "wrong@example.invalid"),
    ).rejects.toThrow();
    expect(await test.inspect()).toEqual(before);
    // Fail after password/revision writes, proving that the authoritative transaction rolls them back.
    await test.setRecoveryFailure(true);
    await expect(test.command("recover", "new owner password")).rejects.toThrow();
    expect(await test.inspect()).toEqual(before);
    await test.setRecoveryFailure(false);
    await test.command("recover", "new owner password");
    const after = await test.inspect();
    expect(after.owners).toHaveLength(1);
    expect(after.owners).not.toEqual(before.owners);
    expect(after.passwords).not.toEqual(before.passwords);
    expect(after.sessions).toEqual([]);

    for (const cookie of [first, second]) {
      expect((await test.admin("/api/admin/check", "GET", cookie)).status).toBe(401);
    }

    expect((await test.auth("signIn", { email, password })).status).not.toBe(200);
    expect((await test.auth("signIn", { email, password: "new owner password" })).status).toBe(200);

    const beforeInvalid = await test.inspect();
    await expect(test.command("recover", "too short")).rejects.toThrow(
      "Use a password of 12–1024 characters.",
    );
    expect(await test.inspect()).toEqual(beforeInvalid);
  } finally {
    await test.close();
  }
});

it("rejects malformed origins and requires explicit HTTPS configuration for production", async () => {
  for (const values of [
    { NODE_ENV: "production" },
    { NODE_ENV: "production", AUTH_ORIGIN: "http://localhost:5173" },
    { NODE_ENV: "prod" },
    { AUTH_ORIGIN: "" },
    { AUTH_ORIGIN: "https://cms.example.invalid/" },
    { AUTH_ORIGIN: "https://cms.example.invalid/path" },
    { AUTH_ORIGIN: "https://cms.example.invalid?x=y" },
    { AUTH_ORIGIN: "http://cms.example.invalid" },
    { AUTH_ORIGIN: "https://*.example.invalid" },
    { AUTH_ORIGIN: "https://user:password@cms.example.invalid" },
    { AUTH_ORIGIN: "null" },
  ]) {
    const result = await Effect.runPromise(
      loadOwnerHttpOptions.pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown(values, { preserveEmptyStrings: true })),
        ),
        Effect.result,
      ),
    );

    expect(result._tag).toBe("Failure");

    if (Predicate.isTagged(result, "Failure"))
      expect(result.failure).toBeInstanceOf(OwnerSecurityConfigurationError);
    expect(JSON.stringify(result)).not.toContain("user:password");
  }

  for (const origin of [
    "http://127.0.0.1:5173",
    "http://[::1]:5173",
    "https://cms.example.invalid",
  ]) {
    const options = await Effect.runPromise(
      loadOwnerHttpOptions.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ AUTH_ORIGIN: origin }))),
      ),
    );

    expect(options.trustedOrigins).toEqual([origin]);
    expect(options.cookie.secure).toBe(origin.startsWith("https:"));
  }
});

it("never grants owner claims to a different persisted subject", async () => {
  const test = await fixture();

  try {
    await test.command("create");
    // Simulate corrupted/imported data, not a supported additional account.
    await test.corruptSubject();
    const response = await test.auth("signIn", { email, password });
    expect(response.status).not.toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toContain("PasswordUnavailable");
    expect((await test.admin("/api/admin/check")).status).toBe(401);
  } finally {
    await test.close();
  }
});

it("bounds concurrent native password work and rejects oversized inputs before derivation", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const hasher = yield* Password.PasswordHashing;

      const results = yield* Effect.all(
        Array.from({ length: 4 }, () => hasher.hash(Redacted.make(password)).pipe(Effect.result)),
        { concurrency: "unbounded" },
      );

      const failed = results.filter((result) => Predicate.isTagged(result, "Failure"));
      const succeeded = results.filter((result) => Predicate.isTagged(result, "Success"));
      expect(failed.length).toBeGreaterThanOrEqual(1);
      expect(succeeded.length).toBeGreaterThanOrEqual(1);

      for (const result of failed) expect(result.failure).toBeInstanceOf(Password.PasswordKdfBusy);

      const oversized = yield* hasher
        .hash(Redacted.make("sensitive".repeat(600)))
        .pipe(Effect.flip);

      expect(oversized).toBeInstanceOf(Password.PasswordInputInvalid);
      expect(JSON.stringify(oversized)).not.toContain("sensitive");
    }).pipe(Effect.provide(HashingLive)),
  );
});

it("refuses noninteractive CLI password input without creating a database or echoing secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zupka-owner-command-"));
  const filename = join(directory, "not-created.sqlite");

  try {
    const response = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/owner.ts", "create", "secret-argument"],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        env: { ...process.env, DATABASE_PATH: filename },
        input: "owner@example.invalid\nsecret-password\nsecret-password\n",
        encoding: "utf8",
        timeout: 10_000,
      },
    );

    expect(response.status).toBe(1);
    expect(response.stderr).toContain("interactive terminal");
    expect(response.stderr + response.stdout).not.toContain("secret");
    await expect(access(filename)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
