import { defineConfig, devices } from "@playwright/test";

// End-to-end runs use `wrangler dev` (real Worker, DO and container) with the fake model.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  use: { baseURL: "http://localhost:8787", trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    { command: "pnpm fake-model", port: 8788, reuseExistingServer: true },
    {
      command: "pnpm build && pnpm dev",
      url: "http://localhost:8787/config",
      timeout: 300_000,
      reuseExistingServer: true,
    },
  ],
});
