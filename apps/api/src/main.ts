import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Config, ConfigProvider, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { ApiLive } from "./app.js";
import { AdminRoutes } from "./admin-http.js";
import { ImageRoutes } from "./image-http.js";
import { EntryRoutes } from "./entry-http.js";
import { AuthRoutes } from "./owner-http.js";
import { StorageLive } from "./storage.js";
import { PublicContentRoutes } from "./public-content-http.js";

const ServerLive = NodeHttpServer.layerConfig(createServer, {
  host: Config.String("HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.Port("PORT").pipe(Config.withDefault(3001)),
});

// Newly created SQLite databases and journals must be private to the operator.
process.umask(0o077);

HttpRouter.serve(
  Layer.mergeAll(ApiLive, AuthRoutes, EntryRoutes, ImageRoutes, PublicContentRoutes, AdminRoutes),
).pipe(
  Layer.provide(ServerLive),
  Layer.provide(StorageLive),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true }))),
  Layer.launch,
  NodeRuntime.runMain,
);
