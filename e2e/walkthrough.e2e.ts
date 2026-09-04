// The walkthrough (WP7.7): every state a visitor can land in, and for each the sentence of state,
// which of Stop / Start / Resume the header offers, and exactly which controls are enabled — with
// the reason in the tooltip of every control that is not. Live, against the local control plane
// (no programs seeded, so the machine idles until someone launches).
import path from "node:path";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";

const wasmPath = path.resolve("programs/mandelbrot/dist/program.wasm");
const CONTROLS = [
  "#stop",
  "#start",
  "#resume",
  "#killHalf",
  "#freezeHalf",
  "#throttleHalf",
  "#resumeAll",
  "#restart",
  "#skip",
  "#killExecution",
  "#spawn1",
  "#spawnN",
  "#killMine",
  "#redundancy",
  "#openEditor",
  "#freezePanel",
  "#backToDashboard",
] as const;
type Probe = {
  sentence: string;
  slot: string;
  enabled: Record<string, boolean>;
  titles: Record<string, string>;
};

/** One evaluate: the page's words and its controls at the same instant. */
async function probe(page: Page): Promise<Probe> {
  return page.evaluate((ids) => {
    // Shown as the visitor sees it: the panel-only controls keep a `hidden` attribute the CSS
    // overrides on a panel tab, and reserved boxes are `visibility: hidden` rather than gone.
    const shown = (el: Element | null): boolean => {
      if (el === null) return false;
      const cs = getComputedStyle(el);
      return cs.display !== "none" && cs.visibility !== "hidden";
    };
    const slot = ["#stop", "#start", "#resume"].find((s) => shown(document.querySelector(s)));
    const enabled: Record<string, boolean> = {};
    const titles: Record<string, string> = {};
    for (const id of ids) {
      const el = document.querySelector(id) as HTMLButtonElement | null;
      enabled[id] = shown(el) && !(el as HTMLButtonElement).disabled;
      titles[id] = el?.title ?? "";
    }
    return {
      sentence: document.querySelector("#notice")?.textContent ?? "",
      slot: slot ?? "none",
      enabled,
      titles,
    };
  }, CONTROLS);
}

const enabledSet = (p: Probe): string[] =>
  Object.entries(p.enabled)
    .filter(([, on]) => on)
    .map(([id]) => id)
    .sort();

async function sentence(page: Page, pattern: RegExp, timeout = 15_000): Promise<Probe> {
  // Polls the sentence itself, so a miss shows what the page said instead.
  await expect
    .poll(async () => (await probe(page)).sentence, { timeout, intervals: [250] })
    .toMatch(pattern);
  return probe(page);
}

const DASHBOARD_LIVE = [
  "#freezeHalf",
  "#killHalf",
  "#killMine",
  "#openEditor",
  "#redundancy",
  "#resumeAll",
  "#spawn1",
  "#spawnN",
  "#throttleHalf",
];

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`walkthrough-${name}.png`) });
}

test("the dashboard says what the machine does in every state and offers only what applies", async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  // 1. Live, idle: the loop has nothing to run here (nothing is seeded); Stop would hold it.
  await page.goto("/");
  await expect(page.locator("#machine")).toHaveText(/live/, { timeout: 60_000 });
  // Another suite may have left a launch planning with no nodes, or the loop held: clear it first.
  await page.waitForTimeout(1_000);
  if (await page.locator("#killExecution").isEnabled()) {
    await page.click("#killExecution");
    await expect(page.locator("#failure")).toBeVisible({ timeout: 15_000 });
  }
  for (const drop of await page.locator("#queue [data-drop]").all()) await drop.click();
  if (await page.locator("#start").isVisible()) await page.click("#start");
  let p = await sentence(
    page,
    /^(idle · the loop starts a frame when someone watches|your \S+ e\d+ failed · the loop is free again)$/,
  );
  expect(p.slot).toBe("#stop");
  expect(enabledSet(p)).toEqual([...DASHBOARD_LIVE, "#stop"].sort());
  for (const id of ["#restart", "#skip", "#killExecution"])
    expect(p.titles[id]).toContain("nothing is running");
  await shot(page, "idle");

  // 2. Stopped by a person: the echo first, then the sentence; Start is the one thing to do.
  await page.click("#stop");
  await expect(page.locator("#notice")).toContainText("the loop is held until Start");
  p = await sentence(page, /^stopped by you · nothing runs until Start/);
  expect(p.slot).toBe("#start");
  expect(p.enabled["#stop"]).toBe(false);
  await shot(page, "stopped");
  await page.click("#start");
  p = await sentence(
    page,
    /^(idle · the loop starts a frame|your \S+ e\d+ failed · the loop is free again)/,
  );
  expect(p.slot).toBe("#stop");

  // 3. Paused by the editor tab; a dropped module launches from there and the pause ends.
  const opened = context.waitForEvent("page");
  await page.click("#openEditor");
  const editor = await opened;
  await expect(editor.locator("#machine")).toHaveText(/live/, { timeout: 60_000 });
  await expect(editor.locator("#pauseState")).toContainText("paused while this tab is open");
  p = await sentence(page, /^paused · the editor tab is open/);
  expect(p.slot).toBe("#resume");
  await shot(page, "paused");
  await editor.locator("#wasmFile").setInputFiles(wasmPath);
  await expect(editor.locator("#launch")).toBeEnabled({ timeout: 15_000 });
  await expect(editor.locator("#source")).toHaveValue(/has no source here/);
  await expect(editor.locator("#compile")).toBeDisabled();
  await editor.locator("#programName").fill("walk");
  await editor.click("#launch");
  await expect(editor.locator("#launchInfo")).toContainText(/answered|queued as|running as/, {
    timeout: 30_000,
  });
  await expect(editor.locator("#pauseState")).toContainText("launched · the pause ended");
  // 4. A person's launch runs (planning: there are no nodes); Stop is back, and so are the
  // controls that need something running.
  // The host page lends a node of its own, so the launch is planning or already rendering.
  p = await sentence(
    page,
    /^running your walk e\d+ · (planning|render|stage \d+|folding) · \d+ nodes? · the loop waits behind it$/,
  );
  expect(p.slot).toBe("#stop");
  expect(enabledSet(p)).toEqual(
    [...DASHBOARD_LIVE, "#stop", "#restart", "#skip", "#killExecution"].sort(),
  );
  await shot(page, "your-launch");
  // 5. Killed: the failure box says why once, the stage does not repeat it in red, the loop has
  // yielded to the person, Start is the way on.
  await page.click("#killExecution");
  await expect(page.locator("#failure")).toContainText("cancelled by an operator", {
    timeout: 15_000,
  });
  p = await sentence(page, /^your walk e\d+ failed · the result stays · the loop waits for Start/);
  expect(p.slot).toBe("#start");
  expect(p.enabled["#killExecution"]).toBe(false);
  await shot(page, "failed");
  await editor.close();
  await page.click("#start");
  // The loop is free again; the failed launch stays on the stage as the last thing that happened.
  await sentence(page, /^your walk e\d+ failed · the loop is free again$/);
});

test("observing, the demo, a panel tab, and the demo's editor each say what they are", async ({
  page,
}) => {
  test.setTimeout(180_000);
  // Observe-only: the sentence says so, spawn stays and says why it is off.
  await page.goto("/?observe");
  await expect(page.locator("#machine")).toHaveText(/live/, { timeout: 60_000 });
  let p = await sentence(page, /^observing · this tab lends no cores · /);
  for (const id of ["#spawn1", "#spawnN", "#killMine"]) {
    expect(p.enabled[id]).toBe(false);
    expect(p.titles[id]).toContain("lends no cores");
  }
  await expect(page.locator("#spawnHint")).toContainText("Observing: this tab lends no cores");
  await shot(page, "observe");
  // The demo: the sentence names it in the header's status line, everything works in the page.
  await page.goto("/?demo=1&speed=12");
  await expect(page.locator("#machine")).toHaveText("live · demo", { timeout: 30_000 });
  p = await sentence(
    page,
    /^demo · a scripted cluster inside this page, nothing is sent anywhere · /,
  );
  expect(enabledSet(p)).toContain("#killHalf");
  await shot(page, "demo");
  // A panel tab: nothing that drives the machine, a way back that keeps the page's mode.
  await page.goto("/?observe&panel=ledger");
  await expect(page.locator("#machine")).toHaveText(/live/, { timeout: 60_000 });
  p = await probe(page);
  for (const id of ["#stop", "#start", "#resume", "#openEditor"]) expect(p.enabled[id]).toBe(false);
  expect(p.enabled["#freezePanel"]).toBe(true);
  expect(p.enabled["#backToDashboard"]).toBe(true);
  await expect(page.locator("#backToDashboard")).toHaveAttribute("href", "/?observe=");
  await shot(page, "panel-tab");
  // The demo's editor: the compile is real, launching is not on offer, and it says so.
  await page.goto("/editor.html?demo=1");
  await expect(page.locator("#machine")).toHaveText("demo");
  await expect(page.locator("#pauseState")).toContainText("nothing is sent anywhere");
  await page.locator("#example").selectOption("hello");
  await page.click("#compile");
  await expect(page.locator("#editorStatus")).toHaveText(/compiled in \d+ ms/, {
    timeout: 180_000,
  });
  await expect(page.locator("#launch")).toBeDisabled();
  await expect(page.locator("#launch")).toHaveAttribute("title", /demo/);
  await shot(page, "editor-demo");
});
