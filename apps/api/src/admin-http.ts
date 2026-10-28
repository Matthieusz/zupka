import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Config, Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse, Mime } from "effect/http";

/** Built admin assets are absent, unreadable, or contain symbolic links. Startup fails closed. */
export class AdminBuildError extends Schema.TaggedError<AdminBuildError>()("AdminBuildError", {
  message: Schema.String,
}) {}

// Snapshot only index.html and assets at startup, never request-derived filesystem paths.
// This small, public build stays immutable for the process lifetime; storage is never mounted.
async function readBuild(root: string) {
  const files = new Map<string, Uint8Array>();

  async function read(relative: string): Promise<void> {
    const path = join(root, relative);
    const info = await lstat(path);

    if (info.isSymbolicLink()) throw new Error("Symbolic links are not admin assets.");

    if (info.isDirectory()) {
      for (const name of await readdir(path)) await read(`${relative}/${name}`);
    } else if (info.isFile()) {
      files.set(`/${relative}`, await readFile(path));
    } else {
      throw new Error("Unsupported admin asset.");
    }
  }

  if (!(await lstat(root)).isDirectory()) throw new Error("Missing admin build.");
  await read("index.html");
  await read("assets");

  return files;
}

/** Serve the compiled admin on the API origin. Development uses Vite unless ADMIN_DIST is explicit.
 * Only GET/HEAD navigations can fall back to HTML; API, storage, dot paths and missing assets cannot.
 * Files are public build snapshots, so no symlink or traversal can reach runtime storage.
 */
export const AdminRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const mode = yield* Config.String("NODE_ENV").pipe(Config.withDefault("development"));
    const configured = yield* Config.option(Config.String("ADMIN_DIST"));

    if (mode !== "production" && Option.isNone(configured)) return Layer.empty;

    const root = Option.getOrElse(configured, () =>
      fileURLToPath(new URL("./public", import.meta.url)),
    );

    const files = yield* Effect.tryPromise({
      try: () => readBuild(root),
      catch: () =>
        new AdminBuildError({
          message: "Cannot load the built admin. Run pnpm build and check ADMIN_DIST.",
        }),
    });

    const index = files.get("/index.html");

    if (index === undefined) return yield* new AdminBuildError({ message: "Missing admin index." });

    return HttpRouter.add(
      "GET",
      "/*",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const pathname = request.url.split("?")[0];

        const denied = HttpServerResponse.empty({
          status: 404,
          headers: { "cache-control": "no-store" },
        });

        // Match canonical, literal paths only. Encoded separators/dots never become filesystem input.
        if (
          !pathname ||
          /[%\\]/.test(pathname) ||
          pathname.includes("\0") ||
          pathname.split("/").some((part) => part.startsWith(".")) ||
          /^\/(api|uploads|data)(\/|$)/.test(pathname)
        )
          return denied;

        const asset = files.get(pathname);

        const html =
          pathname === "/" ||
          pathname === "/index.html" ||
          (!pathname.includes(".") &&
            !pathname.startsWith("/assets/") &&
            request.headers.accept?.includes("text/html"));

        const bytes = asset ?? (html ? index : undefined);

        if (bytes === undefined) return denied;

        const contentType =
          asset === undefined || html
            ? "text/html; charset=utf-8"
            : Option.getOrElse(Mime.getType(pathname), () => "application/octet-stream");

        const headers = {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-length": String(bytes.byteLength),
        };

        return request.method === "HEAD"
          ? HttpServerResponse.empty({
              status: 200,
              headers: { ...headers, "content-type": contentType },
            })
          : HttpServerResponse.uint8Array(bytes, { headers, contentType });
      }),
    );
  }),
);
