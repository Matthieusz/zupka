import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { svelteTesting } from "@testing-library/svelte/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [svelte(), tailwindcss(), svelteTesting()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // Do not let Vite's workspace-wide /@fs fallback expose API storage or owner credentials.
    fs: {
      allow: [
        fileURLToPath(new URL(".", import.meta.url)),
        fileURLToPath(new URL("../../packages", import.meta.url)),
        fileURLToPath(new URL("../../node_modules", import.meta.url)),
      ],
    },
    proxy: { "/api": "http://127.0.0.1:3001" },
  },
  test: {
    name: "web",
    environment: "jsdom",
    server: { deps: { inline: ["bits-ui", "@tanstack/svelte-query"] } },
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
