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
  // The suites share one local control plane, and since WP2.3 an upload really launches: files
  // run one at a time, in name order, so a launch in one suite is not a surprise in another.
  workers: 1,
  // One retry on CI's shared runner (WP8.1); none locally, where a flake should be seen.
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  timeout: 30_000,
  use: {
    baseURL: process.env.TABFRAME_URL ?? `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: local
    ? {
        // The programs build first: the editor test compares a page compile to the build's module.
        command:
          "node packages/sdk-as/scripts/build-programs.ts && bun packages/web/scripts/build.ts && node packages/control-plane/src/main.ts",
        url: `http://127.0.0.1:${port}/config.json`,
        reuseExistingServer: false,
        timeout: 60_000,
        env: {
          TABFRAME_MODE: "local",
          TABFRAME_PUBLIC_PORT: String(port),
          TABFRAME_PRIVATE_PORT: String(port + 1),
          TABFRAME_WEB_DIR: "packages/web/dist",
          TABFRAME_TICK_MS: "100",
          // No seeding: these suites want an idle machine. The pipeline in a browser is
          // exercised by the live tests that point at a seeded server.
          TABFRAME_PROGRAMS_DIR: "",
        },
      }
    : undefined,
});
