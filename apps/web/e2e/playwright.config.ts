import { defineConfig } from "@playwright/test";

const origin = URL.parse(process.env.ZUPKA_TEST_ORIGIN ?? "");

// Never point destructive smoke fixtures at a real owner deployment.
if (!origin || origin.protocol !== "https:" || origin.hostname !== "localhost" || !origin.port) {
  throw new Error("Run pnpm verify:v1 to create a disposable HTTPS container fixture.");
}

export default defineConfig({
  testDir: ".",
  testMatch: "cms.spec.ts",
  outputDir: "../../../test-results/browser",
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: {
    baseURL: origin.origin,
    browserName: "chromium",
    ignoreHTTPSErrors: true, // Test-only self-signed certificate; TLS/cookie/Origin checks stay real.
    viewport: { width: 1440, height: 900 },
    trace: "off", // Do not persist request bodies, credentials or session cookies.
  },
});
