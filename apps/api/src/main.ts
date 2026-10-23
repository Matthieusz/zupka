import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Config, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { ApiLive } from "./app.js";

const ServerLive = NodeHttpServer.layerConfig(createServer, {
  host: Config.String("HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.Port("PORT").pipe(Config.withDefault(3001)),
});

HttpRouter.serve(ApiLive).pipe(Layer.provide(ServerLive), Layer.launch, NodeRuntime.runMain);
