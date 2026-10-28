import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { Deferred, Effect } from "effect";
import { afterAll, beforeAll, expect, it, vi } from "vite-plus/test";
import Root from "../Root.svelte";
import { contentTypes, entryPage, exampleEntry } from "../testing/admin-fixtures.js";

let transport: typeof globalThis.fetch = async () => Response.error();

beforeAll(() => {
  const fetch: typeof globalThis.fetch = (...args) => transport(...args);

  vi.stubGlobal("fetch", fetch);
});

afterAll(() => vi.unstubAllGlobals());

it("signs in, refreshes the session, and returns to the form after logout", async () => {
  const now = Date.now();

  const session = JSON.stringify({
    subjectId: "owner",
    sessionId: "A".repeat(43),
    securityRevision: "revision-1",
    issuedAt: now,
    expiresAt: now + 60_000,
    absoluteExpiresAt: now + 120_000,
    claims: { role: "owner" },
    assurance: { method: "password", factors: ["knowledge"], authenticatedAt: now },
  });

  const success = (json: string) =>
    new Response(`{"_tag":"Success","value":${json}}`, {
      headers: { "content-type": "application/json" },
    });

  let signedIn = false;

  transport = async (input) => {
    const url = input instanceof Request ? input.url : String(input);

    if (url.endsWith("/content-types")) return Response.json(contentTypes);

    if (url.includes("/api/admin/entries/"))
      return Response.json(entryPage([exampleEntry("Owner entry")]));

    if (url.endsWith("/signIn")) {
      signedIn = true;

      return success(`{"_tag":"Authenticated","session":${session}}`);
    }

    if (url.endsWith("/signOut")) {
      signedIn = false;

      return success('{"clearCredential":true,"invalidation":"revoked"}');
    }

    return success(signedIn ? session : "null");
  };

  render(Root);
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Email"), "owner@example.invalid");
  await user.type(screen.getByLabelText("Password"), "a sample password");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("heading", { name: "Owner entry" });
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  expect(await screen.findByLabelText("Password")).toHaveProperty("value", "");
});

it("disables duplicate submissions and clears the password after a rejected sign-in", async () => {
  const response = Deferred.makeUnsafe<Response>();
  let attempts = 0;

  transport = (input) => {
    const url = input instanceof Request ? input.url : String(input);

    if (url.endsWith("/api/health")) return Promise.resolve(Response.json({ status: "ok" }));

    if (url.endsWith("/getSession")) {
      return Promise.resolve(
        new Response('{"_tag":"Success","value":null}', {
          headers: { "content-type": "application/json" },
        }),
      );
    }

    attempts += 1;

    return Effect.runPromise(Deferred.await(response));
  };

  render(Root);

  const user = userEvent.setup();
  const email = await screen.findByLabelText("Email");
  const password = screen.getByLabelText("Password");

  await user.type(email, "owner@example.invalid");
  await user.type(password, "a sample password");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  expect(screen.getByRole("button", { name: "Signing in…" })).toHaveProperty("disabled", true);
  expect(attempts).toBe(1);
  Effect.runSync(Deferred.succeed(response, Response.error()));
  await screen.findByText("Sign in failed. Check your email and password, then try again.");
  await waitFor(() => expect(password).toHaveProperty("value", ""));
  expect(email).toHaveProperty("value", "owner@example.invalid");
  expect(attempts).toBe(1);
});
