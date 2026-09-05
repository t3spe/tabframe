// The money shot: ten browser nodes render a Mandelbrot frame, half of them are killed mid-frame,
// and every tile the page painted hashes to the golden the SDK suite pins. Nothing here is
// simulated: the tabs run the real sandbox, upload to the real store, and the control plane is the
// real process behind the Playwright web server.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  ACCEPTED,
  counter,
  dropModule,
  installWatcher,
  launchFromEditor,
  openEditorTab,
  watched,
} from "./helpers.ts";

const goldens = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../programs/mandelbrot/goldens.json"), "utf8"),
) as { params: Record<string, unknown>; taskCount: number; hashes: string[] };

/**
 * Finished tiles by task id with their output hashes, from the dashboard's own state — which
 * resubscribes for a snapshot whenever it misses an event — merged with what the watcher saw.
 * A slow runner floods a raw observer socket into a gap; the dashboard recovers, the watcher
 * alone does not (a CI run stalled at 259 of 640 that way). Self-contained: `page.evaluate` ships
 * only the function it is given.
 */
function tileOutputs(): Record<string, string> {
  const out: Record<string, string> = { ...(window.__watch?.done ?? {}) };
  const debug = window.tabframe;
  if (debug && "tiles" in debug) {
    for (const [id, t] of debug.state.tasks) {
      if (t.kind === "run" && t.status === "done" && t.output) out[id] = t.output;
    }
  }
  return out;
}

/** The same count, self-contained for the same reason. */
function tilesDone(): number {
  const w = window.__watch;
  if (!w) return -1;
  const seen = new Set(Object.keys(w.done));
  const debug = window.tabframe;
  if (debug && "tiles" in debug) {
    for (const [id, t] of debug.state.tasks) {
      if (t.kind === "run" && t.status === "done" && t.output) seen.add(id);
    }
  }
  return seen.size;
}

test("ten tabs render a frame, half are killed mid-frame, and every tile matches its golden", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto("/");
  await expect(page.locator("#machine")).toHaveText(/live/, { timeout: 30_000 });
  await page.evaluate(installWatcher);

  // One node comes up with the page; nine more make ten.
  for (let i = 0; i < 9; i++) await page.click("#spawn1");
  await expect(page.locator("#counts")).toHaveText(/10 nodes/, { timeout: 60_000 });

  // The Playwright control plane seeds nothing, so the frame is launched the way a visitor would:
  // drop the built module into the editor and launch it with the golden parameters. A name of its
  // own: the suites share one control plane, and two programs called the same thing would make the
  // panels suite's launch button ambiguous.
  const editor = await openEditorTab(page.context());
  await dropModule(editor);
  await launchFromEditor(
    editor,
    { name: "mandelbrot-money-shot", view: "tiles", params: JSON.stringify(goldens.params) },
    ACCEPTED,
  );
  await editor.close(); // the tab's pause (lifted by the launch) is gone with it

  // Wait until the frame is well under way, then kill half.
  await expect
    .poll(async () => page.evaluate(tilesDone), {
      timeout: 120_000,
      intervals: [500],
    })
    .toBeGreaterThan(60);
  const beforeKill = await page.evaluate(tilesDone);
  await page.click("#killHalf");
  // The dashboard reports the victims leaving and their work being taken back — or, on a slow
  // runner where overdue attempts had already been twinned, their twins carrying on: either way
  // the counters move (a CI run saw five departures and no "taken back" line at all).
  await expect(page.locator("#activity")).toContainText("left (closed)", { timeout: 20_000 });
  // Whether the recovery is *visible* depends on what the victims held at that instant: on a fast
  // machine the frame can be over before the kill lands (a 14 s run has been seen), and a CI
  // runner has twice shown five departures with nothing taken back. The proof this test owns is
  // the frame completing with every tile matching; the counters are reported for the record.
  await page.waitForTimeout(2_000);
  const recovery = {
    reassigned: await counter(page, "reassigned"),
    speculated: await counter(page, "speculated"),
    doneAtKill: beforeKill,
    doneNow: await page.evaluate(tilesDone),
    nodes: await page.locator("#counts").textContent(),
  };
  console.log(`[money-shot] after kill half: ${JSON.stringify(recovery)}`);
  // The cluster is short-handed; the page spawns nothing new on its own.
  await expect(page.locator("#counts")).toHaveText(/[1-9] nodes/, { timeout: 20_000 });

  // The frame completes anyway. When it does not (a CI runner stalled at 215 of 640 twice), what
  // the machine looked like is worth more than the number, so it is dumped before the failure.
  try {
    await expect
      .poll(async () => page.evaluate(tilesDone), {
        timeout: 180_000,
        intervals: [1_000],
      })
      .toBeGreaterThanOrEqual(goldens.taskCount);
  } catch (err) {
    const dump = await page.evaluate(() => {
      const w = window.__watch;
      const text = (sel: string) => document.querySelector(sel)?.textContent ?? "";
      const rows = [...document.querySelectorAll("#nodes tbody tr")].map((r) => r.textContent);
      const activity = [...document.querySelectorAll("#activity li")]
        .slice(0, 20)
        .map((li) => li.textContent);
      return {
        exec: text("#exec"),
        machine: text("#machine"),
        counters: text("#counters"),
        counts: text("#counts"),
        failure: text("#failure"),
        nodes: rows,
        activity,
        watcherFailed: w?.failed ?? null,
        watcherFinished: w?.finished ?? null,
      };
    });
    console.log(`[money-shot] stalled: ${JSON.stringify(dump)}`);
    throw err;
  }
  expect(beforeKill).toBeLessThan(goldens.taskCount);

  const outputs = Object.values(await page.evaluate(tileOutputs));
  const failures = await page.evaluate(watched).then((w) => w.failed);
  expect(failures).toEqual([]);
  // The frame repeats tiles in its flat regions, so compare multisets.
  const sorted = [...outputs].sort().slice(0, goldens.taskCount);
  const goldenSorted = [...goldens.hashes].sort();
  expect(sorted).toEqual(goldenSorted);

  // The page paints tiles as it fetches and re-hashes their blobs, which lags the events; wait
  // for it to catch up rather than reading the count once (it read exactly 320 on a CI runner).
  const painted = () =>
    page
      .locator("#tileStats")
      .textContent()
      .then((t) => Number(/(\d+) painted/.exec(t ?? "")?.[1] ?? "0"));
  await expect
    .poll(painted, { timeout: 60_000, intervals: [500] })
    .toBeGreaterThanOrEqual(goldens.taskCount);
  expect((await page.locator("#tileStats").textContent()) ?? "").toContain("0 refused");

  // And the canvas is not blank.
  const ink = await page.evaluate(() => {
    const canvas = document.querySelector("#tiles") as HTMLCanvasElement | null;
    if (!canvas) return 0;
    const ctx = canvas.getContext("2d");
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let lit = 0;
    for (let i = 0; i < data.length; i += 4 * 97) {
      if ((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0) > 30) lit++;
    }
    return lit;
  });
  expect(ink).toBeGreaterThan(50);
});
