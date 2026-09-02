import { defineConfig, devices } from "@playwright/test";

// Browser tests live under e2e/ and are named *.e2e.ts, so `bun test` (which picks up *.test.ts)
// and Playwright never see each other's files. The web server is the real control plane in local
// mode serving the built web bundle; TABFRAME_URL points the tests at a deployed machine instead.
const local = !process.env.TABFRAME_URL;
const port = 4090;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  timeout: 30_000,
  use: {
    baseURL: process.env.TABFRAME_URL ?? `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: local
    ? {
        command: "bun packages/web/scripts/build.ts && node packages/control-plane/src/main.ts",
        url: `http://127.0.0.1:${port}/config.json`,
        reuseExistingServer: false,
        timeout: 60_000,
        env: {
          TABFRAME_MODE: "local",
          TABFRAME_PUBLIC_PORT: String(port),
          TABFRAME_PRIVATE_PORT: String(port + 1),
          TABFRAME_WEB_DIR: "packages/web/dist",
          TABFRAME_TICK_MS: "100",
        },
      }
    : undefined,
});
