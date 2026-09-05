// What the browser suites share: the page's debug surface, typed once; the demo's pause; the built
// module; the editor's open-and-launch sequences; the machine-side watcher.
import path from "node:path";
import { type BrowserContext, expect, type JSHandle, type Page } from "@playwright/test";
import type { TabframeDebug } from "../packages/web/src/debug.ts";

/** The Mandelbrot module the programs build produced; the web server builds it before the suites run. */
export const WASM_PATH = path.resolve(
  import.meta.dirname,
  "../programs/mandelbrot/dist/program.wasm",
);

/**
 * `window.tabframe` as the dashboard exposes it, as a handle: `(await tf(page)).evaluate((d) => …)`
 * runs in the page with `d` typed, and the handle can be passed to `waitForFunction`.
 */
export async function tf(page: Page): Promise<JSHandle<TabframeDebug>> {
  return page.evaluateHandle(() => {
    const debug = window.tabframe;
    if (!debug || !("tiles" in debug))
      throw new Error("the dashboard's debug surface is not there");
    return debug;
  });
}

/** The demo paused where its query asked, and every tile it settled has been fetched or refused. */
export async function waitDemoPaused(page: Page): Promise<void> {
  await page.waitForSelector("body[data-demo-paused]", { timeout: 90_000 });
  await page.waitForFunction((d) => d.tiles.stats.inFlight === 0, await tf(page), {
    timeout: 30_000,
  });
}

/** One of the eight counter chips as a number; a dash reads as zero. */
export const counter = (page: Page, name: string): Promise<number> =>
  page
    .locator(`[data-counter="${name}"] b`)
    .textContent()
    .then((t) => Number((t ?? "0").replace(/[^\d]/g, "") || "0"));

/** The header's `N nodes · M hosts` pill. */
export const counts = (page: Page): Promise<{ nodes: number; hosts: number }> =>
  page
    .locator("#counts")
    .textContent()
    .then((t) => {
      const m = /(\d+) nodes · (\d+) hosts/.exec(t ?? "");
      return { nodes: Number(m?.[1] ?? 0), hosts: Number(m?.[2] ?? 0) };
    });

/** Open the editor in `page` and wait for the machine and the compiler; the drop door is live only then. */
export async function openEditor(page: Page): Promise<void> {
  await page.goto("/editor.html");
  await expect(page.locator("#machine")).toHaveText(/live/, { timeout: 30_000 });
  await expect(page.locator("#editorStatus")).toHaveText(/ready in/, { timeout: 180_000 });
}

/** The editor in a tab of its own beside the dashboard. */
export async function openEditorTab(context: BrowserContext): Promise<Page> {
  const editor = await context.newPage();
  await openEditor(editor);
  return editor;
}

/** Drop the built module into the editor's door; launch is enabled once it passed inspection. */
export async function dropModule(editor: Page, wasm = WASM_PATH): Promise<void> {
  await editor.locator("#wasmFile").setInputFiles(wasm);
  await expect(editor.locator("#launch")).toBeEnabled({ timeout: 30_000 });
}

/** The control plane's answer to a launch: a refusal, or the execution queued or running. */
export const ANY_ANSWER = /answered|queued as|running as/;
/** A launch the machine took: queued behind the loop, or already running. */
export const ACCEPTED = /queued as|running as/;

/** Fill what is given, press launch, and wait for the machine's answer. */
export async function launchFromEditor(
  editor: Page,
  fields: { name?: string; view?: string; params?: string },
  answer: RegExp = ANY_ANSWER,
): Promise<void> {
  if (fields.name !== undefined) await editor.locator("#programName").fill(fields.name);
  if (fields.view !== undefined) await editor.locator("#programView").selectOption(fields.view);
  if (fields.params !== undefined) await editor.locator("#programParams").fill(fields.params);
  await editor.click("#launch");
  await expect(editor.locator("#launchInfo")).toContainText(answer, { timeout: 60_000 });
}

/** Kill the running execution from a dashboard page; the failure banner names the reason. */
export async function killRunning(dashboard: Page, timeout = 15_000): Promise<void> {
  const kill = dashboard.locator("#killExecution");
  await expect(kill).toBeVisible({ timeout });
  await kill.click();
  await expect(dashboard.locator("#failure")).toContainText("cancelled by an operator", {
    timeout,
  });
}

/** Leave the shared machine idle for the suites that follow: kill the leftover execution from a fresh observer tab. */
export async function killRunningFromNewTab(context: BrowserContext): Promise<void> {
  const dash = await context.newPage();
  await dash.goto("/?observe");
  await expect(dash.locator("#machine")).toHaveText(/live/, { timeout: 30_000 });
  await killRunning(dash);
  await dash.close();
}

/** What a second observer socket inside the page saw of the machine's own events. */
export type Watch = {
  /** Event names, with the reason after a colon where one was carried. */
  seen: string[];
  /** Finished tiles by task id with their output hashes. */
  done: Record<string, string>;
  failed: string[];
  finished: string | null;
};

declare global {
  interface Window {
    __watch?: Watch;
  }
}

/**
 * Watch the machine from inside the page: a second observer socket collects the events the
 * dashboard is reacting to, so a test can check what the page never shows. Self-contained, since
 * `page.evaluate` ships only the function it is given.
 */
export function installWatcher(): void {
  if (window.__watch) return;
  const w: Watch = { seen: [], done: {}, failed: [], finished: null };
  window.__watch = w;
  void (async () => {
    const config = (await (await fetch("/config.json")).json()) as { sessionUrl: string };
    const session = (await (await fetch(config.sessionUrl)).json()) as {
      endpoint?: string;
      generation?: number;
    };
    if (!session.endpoint) return;
    const gen = session.generation ?? 1;
    const ws = new WebSocket(`${session.endpoint}/observer`);
    ws.onopen = () => ws.send(JSON.stringify({ t: "subscribe", v: 1, gen }));
    ws.onmessage = (m) => {
      const e = JSON.parse(String(m.data)) as {
        t: string;
        taskId?: string;
        output?: string;
        place?: unknown;
        reason?: string;
        executionId?: string;
      };
      w.seen.push(e.reason ? `${e.t}:${e.reason.slice(0, 80)}` : e.t);
      if (e.t === "taskDone" && e.place && e.taskId && e.output) w.done[e.taskId] = e.output;
      if (e.t === "taskFailed" || e.t === "executionFailed") w.failed.push(e.reason ?? "?");
      if (e.t === "executionDone") w.finished = e.executionId ?? null;
    };
    setInterval(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: "ping", v: 1, gen }));
    }, 1_500);
  })();
}

/** The watcher's record so far; empty before `installWatcher` ran. */
export function watched(): Watch {
  return window.__watch ?? { seen: [], done: {}, failed: [], finished: null };
}
