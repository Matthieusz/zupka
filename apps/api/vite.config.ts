import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/main.ts", "src/owner.ts", "src/migrate-content.ts"],
    format: "esm",
    platform: "node",
    dts: false,
    sourcemap: true,
    deps: { alwaysBundle: ["@zupka/contracts", "@zupka/shared"] },
  },
});
