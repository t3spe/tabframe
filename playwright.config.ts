import { defineConfig, devices } from "@playwright/test";

// Browser tests live under e2e/ and are named *.e2e.ts, so `bun test` (which picks up *.test.ts)
// and Playwright never see each other's files.
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.TABFRAME_URL ?? "http://localhost:4080",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
