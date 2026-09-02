// The money shot (plan WP2.6): ten browser nodes render a Mandelbrot frame, half of them are
// killed mid-frame, and every tile the page painted hashes to the golden the SDK suite pins.
// Nothing here is simulated: the tabs run the real sandbox, upload to the real store, and the
// control plane is the real process behind the Playwright web server.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const goldens = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../programs/mandelbrot/goldens.json"), "utf8"),
) as { params: Record<string, unknown>; taskCount: number; hashes: string[] };

type Watch = {
  done: Record<string, string>;
  failed: string[];
  finished: string | null;
};

/**
 * Watch the machine from inside the page: a second observer socket collects the events the
 * dashboard is reacting to, so the test can check hashes the page never shows.
 */
function installWatcher(): void {
  const w = window as unknown as { __watch: Watch };
  w.__watch = { done: {}, failed: [], finished: null };
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
      if (e.t === "taskDone" && e.place && e.taskId && e.output)
        w.__watch.done[e.taskId] = e.output;
      if (e.t === "taskFailed" || e.t === "executionFailed") w.__watch.failed.push(e.reason ?? "?");
      if (e.t === "executionDone") w.__watch.finished = e.executionId ?? null;
    };
    setInterval(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: "ping", v: 1, gen }));
    }, 1_500);
  })();
}

/**
 * Finished tiles by task id with their output hashes, from the dashboard's own state — which
 * resubscribes for a snapshot whenever it misses an event — merged with what the watcher saw.
 * A slow runner floods a raw observer socket into a gap; the dashboard recovers, the watcher
 * alone does not (a CI run stalled at 259 of 640 that way).
 */
function tileOutputs(): Record<string, string> {
  const w = (window as unknown as { __watch?: Watch }).__watch;
  const out: Record<string, string> = { ...(w?.done ?? {}) };
  const tf = (
    window as unknown as {
      tabframe?: {
        state: { tasks: Map<string, { kind: string; status: string; output: string | null }> };
      };
    }
  ).tabframe;
  if (tf) {
    for (const [id, t] of tf.state.tasks) {
      if (t.kind === "run" && t.status === "done" && t.output) out[id] = t.output;
    }
  }
  return out;
}

/** The same count, self-contained: `page.evaluate` ships only the function it is given. */
function tilesDone(): number {
  const w = (window as unknown as { __watch?: Watch }).__watch;
  if (!w) return -1;
  const seen = new Set(Object.keys(w.done));
  const tf = (
    window as unknown as {
      tabframe?: {
        state: { tasks: Map<string, { kind: string; status: string; output: string | null }> };
      };
    }
  ).tabframe;
  if (tf) {
    for (const [id, t] of tf.state.tasks) {
      if (t.kind === "run" && t.status === "done" && t.output) seen.add(id);
    }
  }
  return seen.size;
}

const wasmPath = path.resolve(import.meta.dirname, "../programs/mandelbrot/dist/program.wasm");

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
  // drop the built module into the editor and launch it with the golden parameters.
  await page.click("#openEditor");
  await expect(page.locator("#editor")).toBeVisible();
  // The compiler loads lazily; the drop door is live once the editor says it is ready.
  await expect(page.locator("#editorStatus")).toHaveText(/ready in/, { timeout: 180_000 });
  await page.locator("#wasmFile").setInputFiles(wasmPath);
  await expect(page.locator("#launch")).toBeEnabled({ timeout: 30_000 });
  // A name of its own: the suites share one control plane, and two programs called the same
  // thing would make the panels suite's launch button ambiguous.
  await page.locator("#programName").fill("mandelbrot-money-shot");
  await page.locator("#programView").selectOption("tiles");
  await page.locator("#programParams").fill(JSON.stringify(goldens.params));
  await page.click("#launch");
  await expect(page.locator("#launchInfo")).toContainText(/queued as|running as/, {
    timeout: 60_000,
  });
  await page.click("#closeEditor");

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
  const counter = (name: string) =>
    page
      .locator(`[data-counter="${name}"] b`)
      .textContent()
      .then((t) => Number(t ?? "0"));
  // Whether the recovery is *visible* depends on what the victims held at that instant: on a fast
  // machine the frame can be over before the kill lands (a 14 s run has been seen), and a CI
  // runner has twice shown five departures with nothing taken back. The proof this test owns is
  // the frame completing with every tile matching; the counters are reported for the record.
  await page.waitForTimeout(2_000);
  const recovery = {
    reassigned: await counter("reassigned"),
    speculated: await counter("speculated"),
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
      const w = (window as unknown as { __watch?: Watch }).__watch;
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
  const failures = await page.evaluate(
    () => (window as unknown as { __watch: Watch }).__watch.failed,
  );
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
