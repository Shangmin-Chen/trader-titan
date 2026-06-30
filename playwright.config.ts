import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://localhost:8787",
    trace: "on-first-retry"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "mobile-chrome",
      use: { ...devices["Pixel 7"] }
    }
  ],
  webServer: {
    command: "npm run build:cloudflare && wrangler dev --var WORKER_ITEM_PROVIDER:deterministic --port 8787",
    timeout: 120_000,
    url: "http://localhost:8787",
    reuseExistingServer: !process.env.CI
  }
});
