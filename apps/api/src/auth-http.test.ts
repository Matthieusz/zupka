import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import { Client } from "@yielded/auth";
import { OwnerAuth } from "@zupka/contracts";
import { ConfigProvider, Effect, Layer, Redacted } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/http";
import { expect, it } from "vite-plus/test";
import { HashingLive, setOwnerPassword } from "./auth.js";
import { AuthRoutes } from "./owner-http.js";
import { StorageLive } from "./storage.js";

it("persists owner cookie sessions and rejects them after local password recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zupka-auth-"));

  const config = ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      DATABASE_PATH: join(directory, "auth.sqlite"),
      AUTH_ORIGIN: "http://localhost:5173",
    }),
  );

  const operator = Layer.merge(StorageLive, HashingLive).pipe(Layer.provide(config));

  const command = (mode: "create" | "recover", password: string) =>
    Effect.runPromise(
      setOwnerPassword(mode, "owner@example.invalid", Redacted.make(password)).pipe(
        Effect.provide(operator),
      ),
    );

  const makeApp = () =>
    HttpRouter.toWebHandler(
      AuthRoutes.pipe(
        Layer.provide(StorageLive),
        Layer.provide(config),
        Layer.provide(NodeHttpServer.layerHttpServices),
      ),
      { disableLogger: true },
    );

  let app = makeApp();

  const request = (
    name: string,
    payload: { readonly email?: string; readonly password?: string },
    cookie?: string,
    origin = "http://localhost:5173",
  ) =>
    app.handler(
      new Request(`http://localhost:5173/api/auth/${name}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "x-effect-auth-csrf": "1",
          cookie: cookie ?? "",
        },
        body: JSON.stringify({ payload }),
      }),
    );

  try {
    await command("create", "first owner password");
    expect(await (await request("getSession", {})).json()).toHaveProperty("value", null);

    const missingCsrf = await app.handler(
      new Request("http://localhost:5173/api/auth/signIn", {
        method: "POST",
        headers: { origin: "http://localhost:5173", "content-type": "application/json" },
        body: JSON.stringify({
          payload: { email: "owner@example.invalid", password: "first owner password" },
        }),
      }),
    );

    expect(missingCsrf.status).not.toBe(200);
    await expect(command("create", "another owner password")).rejects.toThrow();
    const denied = await request("signIn", { email: "owner@example.invalid", password: "wrong" });
    expect(denied.status).not.toBe(200);

    const forbidden = await request(
      "signIn",
      { email: "owner@example.invalid", password: "first owner password" },
      undefined,
      "http://evil.invalid",
    );

    expect(forbidden.status).not.toBe(200);

    const response = await request("signIn", {
      email: "owner@example.invalid",
      password: "first owner password",
    });

    expect(response.status).toBe(200);

    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");

    expect(cookie).not.toBe("");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    await app.dispose();
    app = makeApp();
    const session = await request("getSession", {}, cookie);
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ value: { subjectId: "owner" } });
    await command("recover", "replacement owner password");
    const expired = await request("getSession", {}, cookie);
    expect(await expired.json()).toHaveProperty("value", null);

    const old = await request("signIn", {
      email: "owner@example.invalid",
      password: "first owner password",
    });

    expect(old.status).not.toBe(200);

    const fresh = await request("signIn", {
      email: "owner@example.invalid",
      password: "replacement owner password",
    });

    expect(fresh.status).toBe(200);

    const freshCookie = fresh.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");

    const logout = await request("signOut", {}, freshCookie);
    expect(logout.status).toBe(200);
    expect(await (await request("getSession", {}, freshCookie)).json()).toHaveProperty(
      "value",
      null,
    );
    expect((await request("register", {})).status).toBe(404);
    expect((await request("requestReset", {})).status).toBe(404);

    // Browser-shaped fetch adapter: only transport cookie handling is simulated.
    // The client, wire envelopes, router, hashing, database, and session logic are real.
    const browserCookies = new Map<string, string>();

    const fetch: typeof globalThis.fetch = async (input, init) => {
      const incoming = new Request(input, init);
      incoming.headers.set("origin", "http://localhost:5173");
      incoming.headers.set("cookie", [...browserCookies.values()].join("; "));
      const outgoing = await app.handler(incoming);
      const cookies = outgoing.headers.getSetCookie();

      for (const cookieValue of cookies) {
        const pair = cookieValue.split(";")[0] ?? "";
        const name = pair.split("=")[0] ?? "";

        if (/max-age=0/i.test(cookieValue)) browserCookies.delete(name);
        else browserCookies.set(name, pair);
      }

      return outgoing;
    };

    const client = Client.make(OwnerAuth, { baseUrl: "http://localhost:5173" });
    await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* client;
        yield* api.auth.signIn({
          email: "owner@example.invalid",
          password: "replacement owner password",
        });
        expect(yield* api.auth.getSession()).toMatchObject({ subjectId: "owner" });
        yield* api.auth.signOut();
        expect(yield* api.auth.getSession()).toBeNull();
      }).pipe(
        Effect.provide(
          client.layerFetch.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
        ),
      ),
    );
  } finally {
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
