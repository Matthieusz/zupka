import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import { ConfigProvider, Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { expect, it } from "vite-plus/test";
import { AdminRoutes } from "./admin-http.js";
import { ApiLive } from "./app.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "zupka-admin-build-"));
  await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Admin</title>");
  await writeFile(join(directory, "assets", "app.js"), "console.log('admin')");
  await writeFile(join(directory, "assets", "app.css"), "body{color:white}");
  // Even a misplaced database outside the assets tree is not served.
  await writeFile(join(directory, "zupka.sqlite"), "private database");

  const app = () =>
    HttpRouter.toWebHandler(
      Layer.mergeAll(
        AdminRoutes,
        ApiLive,
        HttpRouter.add(
          "GET",
          "/api/broken",
          Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "Unavailable" }, { status: 503 })),
        ),
      ).pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ NODE_ENV: "production", ADMIN_DIST: directory }),
          ),
        ),
        Layer.provide(NodeHttpServer.layerHttpServices),
      ),
      { disableLogger: true },
    );

  return { directory, app, close: () => rm(directory, { recursive: true, force: true }) };
}

it("serves admin navigations/assets and HEAD on the API origin without masking API responses", async () => {
  const build = await fixture();
  const app = build.app();

  try {
    for (const path of ["/", "/index.html", "/entries/posts/example", "/?q=hello"]) {
      const response = await app.handler(
        new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toContain("<title>Admin</title>");
    }

    for (const [path, mime] of [
      ["/assets/app.js?v=1", "javascript"],
      ["/assets/app.css", "text/css"],
    ]) {
      const response = await app.handler(new Request(`http://localhost${path}`));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(mime);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.text()).not.toBe("");
    }

    const head = await app.handler(
      new Request("http://localhost/assets/app.js", { method: "HEAD" }),
    );

    expect(head.status).toBe(200);
    expect(Number(head.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await head.text()).toBe("");
    expect(await (await app.handler(new Request("http://localhost/api/health"))).json()).toEqual({
      status: "ok",
    });

    const broken = await app.handler(
      new Request("http://localhost/api/broken", { headers: { accept: "text/html" } }),
    );

    expect(broken.status).toBe(503);
    expect(await broken.json()).toEqual({ error: "Unavailable" });
  } finally {
    await app.dispose();
    await build.close();
  }
});

it("never turns unknown API, storage, traversal, or missing asset requests into SPA HTML", async () => {
  const build = await fixture();
  const app = build.app();

  try {
    for (const path of [
      "/api",
      "/api/missing",
      "/api/admin/missing",
      "/api/auth/register",
      "/assets/missing.js",
      "/assets/missing",
      "/zupka.sqlite",
      "/uploads/private",
      "/data/private",
      "/.env",
      "/%2e%2e%2fsecret",
      "/assets/%2fsecret",
      "/assets/%00",
      "/assets/%ZZ",
      "/not-a-navigation",
    ]) {
      const response = await app.handler(
        new Request(`http://localhost${path}`, {
          headers: { accept: path === "/not-a-navigation" ? "application/json" : "text/html" },
        }),
      );

      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type") ?? "", path).not.toContain("text/html");
      expect(await response.text(), path).not.toContain("private database");
    }

    const write = await app.handler(
      new Request("http://localhost/entries/posts", {
        method: "POST",
        headers: { accept: "text/html" },
      }),
    );

    expect(write.status).toBe(404);
  } finally {
    await app.dispose();
    await build.close();
  }
});

it("fails startup rather than following asset symlinks or serving a missing build", async () => {
  const build = await fixture();
  await symlink(join(build.directory, "zupka.sqlite"), join(build.directory, "assets", "leak.js"));
  let app = build.app();

  try {
    await expect(app.handler(new Request("http://localhost/"))).rejects.toThrow(
      "Cannot load the built admin",
    );
    await app.dispose();
    await rm(join(build.directory, "assets"), { recursive: true });
    app = build.app();
    await expect(app.handler(new Request("http://localhost/"))).rejects.toThrow(
      "Cannot load the built admin",
    );
  } finally {
    await app.dispose();
    await build.close();
  }
});
