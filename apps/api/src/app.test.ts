import { NodeHttpServer } from "@effect/platform-node";
import { Layer, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { Health } from "@zupka/contracts";
import { expect, it } from "vite-plus/test";
import { ApiLive } from "./app.js";

it("serves the health contract through the HTTP router", async () => {
  const app = HttpRouter.toWebHandler(
    ApiLive.pipe(Layer.provide(NodeHttpServer.layerHttpServices)),
    { disableLogger: true },
  );

  try {
    const response = await app.handler(new Request("http://localhost/api/health"));

    expect(response.status).toBe(200);
    expect(Schema.decodeUnknownSync(Health)(await response.json())).toEqual({ status: "ok" });
  } finally {
    await app.dispose();
  }
});

it("returns 404 for an unknown route", async () => {
  const app = HttpRouter.toWebHandler(
    ApiLive.pipe(Layer.provide(NodeHttpServer.layerHttpServices)),
    { disableLogger: true },
  );

  try {
    const response = await app.handler(new Request("http://localhost/api/missing"));

    expect(response.status).toBe(404);
  } finally {
    await app.dispose();
  }
});
