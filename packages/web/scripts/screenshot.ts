// Evidence screenshots for the implementation log: starts a local control plane serving the built
// bundle, opens tabs, and writes a PNG. Usage:
//   node packages/web/scripts/screenshot.ts --out docs/implementation/assets/wp-0.6/two-tabs.png
//   node packages/web/scripts/screenshot.ts --demo --pause 470 --out docs/implementation/assets/wp-1.8/dashboard.png
// `--demo` opens the scripted cluster (`?demo=1`) and pauses it after that many tiles.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const arg = (name: string): string => {
  const i = process.argv.indexOf(name);
  return i > 0 ? (process.argv[i + 1] ?? "") : "";
};
const out = arg("--out");
if (!out) {
  console.error("--out <file.png> is required");
  process.exit(2);
}
const demo = process.argv.includes("--demo");
const pause = arg("--pause") || "470";
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
mkdirSync(path.dirname(out), { recursive: true });
if (demo) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  // `--program <name>` starts the demo's cycle at that program and holds once it has ended, so
  // the word count's bars and files, or the broken program's banner, are what gets captured.
  const program = arg("--program");
  const query = program ? `program=${program}&hold=1` : `pause=${pause}`;
  await page.goto(`http://127.0.0.1:${port}/?demo=1&speed=6&${query}`);
  await page.waitForSelector("body[data-demo-paused]", { timeout: 120_000 });
  if (program === "wordcount") {
    await page.waitForSelector("#result .bars .bar-row", { timeout: 30_000 });
    await page.click('#files li[data-path="/out/2/0"]');
    await page.waitForSelector("#filePreview .bars", { timeout: 30_000 });
    await page.locator("#grid").click({ position: { x: 4, y: 4 } });
    await page.waitForSelector("#taskDetail .task-log .text-view", { timeout: 30_000 });
  }
  await page.waitForFunction(
    () =>
      (window as unknown as { tabframe: { tiles: { stats: { inFlight: number } } } }).tabframe.tiles
        .stats.inFlight === 0,
  );
  await page.waitForTimeout(400);
  await page.screenshot({ path: out, fullPage: true });
} else {
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
  await a.screenshot({ path: out });
}
console.log(`screenshot → ${out}`);
await browser.close();
cp.kill("SIGTERM");
