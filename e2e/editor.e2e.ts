import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

// WP2.4: the in-page editor against the real local control plane. The compiler loads in a worker
// and compiles the prefilled Mandelbrot; the module must hash to what the build produced (the
// web server built programs/mandelbrot/dist first). The drop door validates a real module and
// refuses junk. A launch uploads the bundle over the observer socket and the control plane
// answers — a refusal until WP2.3 teaches the core to take uploaded bundles, a queued execution
// after; either way the round trip is what this test pins.

const wasmPath = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../programs/mandelbrot/dist/program.wasm",
);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// The editor is a page of its own since WP6.4: the dashboard's button opens it in a new tab, and
// the tab holds the machine paused while it lives. The suites go there directly.
async function openEditor(page: Page): Promise<void> {
  await page.goto("/editor.html");
  await expect(page.locator("#machine")).toHaveText(/live/, { timeout: 30_000 });
  await expect(page.locator("#editor")).toBeVisible();
  await expect(page.locator("#source")).toHaveValue(/Mandelbrot/);
  await expect(page.locator("#editorStatus")).toHaveText(/ready in/, { timeout: 120_000 });
}

test("the editor opens from the dashboard in its own tab and holds the machine paused while it lives", async ({
  page,
  context,
}) => {
  await page.goto("/?observe");
  await expect(page.locator("#machine")).toHaveText(/live/, { timeout: 30_000 });
  await expect(page.locator("#resume")).toBeHidden();
  const opened = context.waitForEvent("page");
  await page.click("#openEditor");
  const editor = await opened;
  await expect(editor).toHaveURL(/\/editor\.html$/);
  await expect(editor.locator("#machine")).toHaveText(/live/, { timeout: 30_000 });
  await expect(editor.locator("#pauseState")).toContainText("paused");
  // The dashboard sees the pause and offers Resume.
  await expect(page.locator("#loop")).toContainText("paused by the editor", { timeout: 15_000 });
  await expect(page.locator("#resume")).toBeVisible();
  // Closing the tab lifts it: the control plane resumes when the holder's socket goes away.
  await editor.close();
  await expect(page.locator("#exec")).not.toContainText("paused", { timeout: 15_000 });
  await expect(page.locator("#resume")).toBeHidden();
  // Resume from the dashboard works too, while a tab holds the pause.
  const again = context.waitForEvent("page");
  await page.click("#openEditor");
  const editor2 = await again;
  await expect(page.locator("#resume")).toBeVisible({ timeout: 15_000 });
  await page.click("#resume");
  await expect(page.locator("#resume")).toBeHidden({ timeout: 15_000 });
  await editor2.close();
});

test("the compiler loads in a worker and the page compile is byte-identical to the build", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openEditor(page);
  const loaded = await page.locator("#editorStatus").textContent();
  await page.click("#compile");
  await expect(page.locator("#editorStatus")).toHaveText(/compiled in \d+ ms/, {
    timeout: 120_000,
  });
  const compiled = await page.locator("#editorStatus").textContent();
  console.log(`[editor.e2e] ${loaded}; ${compiled}`);
  const expected = sha256(new Uint8Array(readFileSync(wasmPath)));
  await expect(page.locator("#moduleHash")).toHaveText(expected);
  await expect(page.locator("#moduleInfo")).toContainText("imports env.abort");
  for (const name of ["alloc", "memory", "plan", "run"])
    await expect(page.locator("#moduleInfo")).toContainText(name);
  await expect(page.locator("#moduleInfo")).toContainText("memory max 256 pages");
  await expect(page.locator("#launch")).toBeEnabled();
  await expect(page.locator("#diagnostics li")).toHaveCount(0);
});

test("a broken edit shows diagnostics with the line; reset restores the shipped source", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openEditor(page);
  const source = await page.locator("#source").inputValue();
  const lines = source.split("\n");
  const at = lines.findIndex((l) => l.startsWith("const TILE"));
  lines.splice(at, 0, 'const broken: i32 = "not a number";');
  await page.locator("#source").fill(lines.join("\n"));
  await page.click("#compile");
  await expect(page.locator("#editorStatus")).toHaveText(/1 error/, { timeout: 120_000 });
  const diag = page.locator("#diagnostics li").first();
  await expect(diag).toContainText("ERROR TS2322");
  await expect(diag).toContainText(`assembly/index.ts:${at + 1}:`);
  await expect(page.locator("#launch")).toBeDisabled();
  await page.click("#resetSource");
  await expect(page.locator("#source")).toHaveValue(source);
});

test("the drop door accepts a real module and refuses junk", async ({ page }) => {
  test.setTimeout(240_000);
  await openEditor(page);
  await page.locator("#wasmFile").setInputFiles(wasmPath);
  await expect(page.locator("#moduleInfo")).toContainText("dropped module", { timeout: 15_000 });
  await expect(page.locator("#moduleHash")).toHaveText(
    sha256(new Uint8Array(readFileSync(wasmPath))),
  );
  await expect(page.locator("#programName")).toHaveValue("program");
  await expect(page.locator("#launch")).toBeEnabled();
  await page.locator("#wasmFile").setInputFiles({
    name: "junk.wasm",
    mimeType: "application/wasm",
    buffer: Buffer.from("definitely not a module"),
  });
  await expect(page.locator("#moduleInfo")).toContainText("not a WebAssembly module");
  await page.locator("#wasmFile").setInputFiles({
    name: "empty.wasm",
    mimeType: "application/wasm",
    buffer: Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
  });
  await expect(page.locator("#moduleInfo")).toContainText("refused");
  await expect(page.locator("#launch")).toBeDisabled();
});

test("launch uploads the bundle through the observer socket and the control plane answers", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  await openEditor(page);
  await page.locator("#wasmFile").setInputFiles(wasmPath);
  await expect(page.locator("#launch")).toBeEnabled({ timeout: 15_000 });
  await page.locator("#programParams").fill('{"preset": 2, "palette": "ocean"}');
  await page.click("#launch");
  await expect(page.locator("#launchInfo")).toContainText("launch sent", { timeout: 30_000 });
  const bundle = await page.locator("#bundleHash").textContent();
  expect(bundle).toMatch(/^[0-9a-f]{64}$/);
  // The blobs went to the store: the module and the bundle manifest read back by hash.
  const moduleHash = sha256(new Uint8Array(readFileSync(wasmPath)));
  const mod = await request.get(`/blob/${moduleHash}`);
  expect(mod.status()).toBe(200);
  expect((await mod.body()).length).toBe(readFileSync(wasmPath).length);
  const manifest = await request.get(`/blob/${bundle}`);
  expect(manifest.status()).toBe(200);
  const files = (await manifest.json()) as { version: number; files: Record<string, unknown> };
  expect(files.version).toBe(1);
  expect(Object.keys(files.files).sort()).toEqual(["/manifest.json", "/program.wasm"]);
  // And the control plane answered the launch, one way or the other.
  await expect(page.locator("#launchInfo")).toContainText(/answered|queued as|running as/, {
    timeout: 30_000,
  });
  console.log(`[editor.e2e] ${await page.locator("#launchInfo").textContent()}`);
  // Since WP2.3 the launch is real: the execution would plan forever here (no nodes in observe
  // mode) and then run on the next suite's nodes. Kill it from a dashboard tab so the suites that
  // follow find the machine idle; the failure banner names the reason.
  const dash = await page.context().newPage();
  await dash.goto("/?observe");
  await expect(dash.locator("#machine")).toHaveText(/live/, { timeout: 30_000 });
  const kill = dash.locator("#killExecution");
  await expect(kill).toBeVisible({ timeout: 15_000 });
  await kill.click();
  await expect(dash.locator("#failure")).toContainText("cancelled by an operator", {
    timeout: 15_000,
  });
  await dash.close();
  // Params that are not an object never leave the page.
  await page.locator("#programParams").fill("[1, 2]");
  await page.click("#launch");
  await expect(page.locator("#launchInfo")).toContainText("params must be a JSON object");
});

test("the editor explains itself: a guide from the SDK's README, the machine's limits, and three examples to load", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openEditor(page);
  // The guide is a page of its own behind a link at the top (WP7.5); the editor keeps two lines.
  await expect(page.locator("#editorIntro")).toContainText("two entry points");
  await expect(page.locator("#guideLink")).toHaveAttribute("href", "/guide.html");
  await expect(page.locator("#guide")).toHaveCount(0);
  const guide = await page.context().newPage();
  await guide.goto("/guide.html");
  await expect(guide.locator("#guideBody h3")).toContainText(["Writing a program"]);
  await expect(guide.locator("#guideBody")).toContainText("plan");
  await expect(guide.locator("#guideBody pre")).not.toHaveCount(0);
  await expect(guide.locator("#guideLimits")).toContainText("256 pages");
  await expect(guide.locator("nav a[href='/editor.html']")).toBeVisible();
  await guide.close();
  // The examples: hello loads, compiles in the page, and its manifest fills the form.
  await expect(page.locator("#example")).toHaveValue("mandelbrot");
  await page.locator("#example").selectOption("hello");
  await expect(page.locator("#source")).toHaveValue(/hello, \$\{who\}/);
  await expect(page.locator("#programName")).toHaveValue("hello");
  await expect(page.locator("#programView")).toHaveValue("text");
  await expect(page.locator("#programParams")).toHaveValue('{"who":"world"}');
  await expect(page.locator("#exampleNote")).toContainText("smallest program");
  await page.click("#compile");
  await expect(page.locator("#editorStatus")).toHaveText(/compiled in \d+ ms/, {
    timeout: 180_000,
  });
  await expect(page.locator("#diagnostics li")).toHaveCount(0);
  await expect(page.locator("#launch")).toBeEnabled();
  // Word count is there to read, and says what a launch from here would lack.
  await page.locator("#example").selectOption("wordcount");
  await expect(page.locator("#source")).toHaveValue(/three stages/);
  await expect(page.locator("#exampleNote")).toContainText("no inputs");
  // Reset returns to the selected example, not always to Mandelbrot.
  await page.locator("#source").fill("garbage");
  await page.click("#resetSource");
  await expect(page.locator("#source")).toHaveValue(/three stages/);
});

test("the editor fills the viewport: the source takes the height, nothing scrolls sideways (WP7.5)", async ({
  page,
}) => {
  for (const [w, h] of [
    [1280, 800],
    [1440, 900],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/editor.html");
    await expect(page.locator("#source")).toBeVisible();
    const m = await page.evaluate(() => {
      const src = (document.querySelector("#source") as HTMLElement).getBoundingClientRect();
      const doc = document.documentElement;
      return {
        sourceBottom: src.bottom,
        sourceHeight: src.height,
        scrollW: doc.scrollWidth,
        clientW: doc.clientWidth,
        pageScroll: doc.scrollHeight - doc.clientHeight,
      };
    });
    expect(m.sourceHeight).toBeGreaterThan(h * 0.45);
    expect(m.sourceBottom).toBeLessThanOrEqual(h);
    expect(m.scrollW).toBeLessThanOrEqual(m.clientW);
    expect(m.pageScroll).toBeLessThanOrEqual(1);
  }
});
