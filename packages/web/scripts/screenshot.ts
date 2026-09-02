// Evidence screenshots for the implementation log: starts a local control plane serving the built
// bundle, opens tabs, spawns nodes, and writes a PNG. Usage:
//   node packages/web/scripts/screenshot.ts --out docs/implementation/assets/wp-0.6/two-tabs.png
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const outArg = process.argv.indexOf("--out");
const out = outArg > 0 ? (process.argv[outArg + 1] ?? "") : "";
if (!out) {
  console.error("--out <file.png> is required");
  process.exit(2);
}
const port = 4092;
const cp = spawn("node", ["packages/control-plane/src/main.ts"], {
  env: {
    ...process.env,
    TABFRAME_MODE: "local",
    TABFRAME_PUBLIC_PORT: String(port),
    TABFRAME_PRIVATE_PORT: String(port + 1),
    TABFRAME_WEB_DIR: "packages/web/dist",
    TABFRAME_TICK_MS: "100",
  },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise<void>((resolve) =>
  cp.stdout?.on("data", (d: Buffer) => String(d).includes('"listening"') && resolve()),
);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 640 } });
const a = await ctx.newPage();
const b = await ctx.newPage();
await a.goto(`http://127.0.0.1:${port}/`);
await b.goto(`http://127.0.0.1:${port}/`);
await a.click("#spawn1");
await a.waitForFunction(
  () => document.querySelector("#counts")?.textContent === "3 nodes · 2 hosts",
  null,
  { timeout: 15_000 },
);
mkdirSync(path.dirname(out), { recursive: true });
await a.screenshot({ path: out });
console.log(`screenshot → ${out}`);
await browser.close();
cp.kill("SIGTERM");
