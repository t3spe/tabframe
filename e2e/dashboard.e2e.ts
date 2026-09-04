import { expect, type Page, test } from "@playwright/test";

// WP1.8: the dashboard. The demo mode drives the reducer with a scripted cluster inside the page
// (no program runs locally before WP1.6/1.7), so tiles, the grid, counters, and the story beats
// are checked there; the controls are checked against the real local control plane.

interface Probe {
  tasks: number;
  placedBeyondFirstPage: boolean;
  painted: number;
  flags: [string, string][];
  inFlight: number;
  done: number;
  colors: number;
  gridHidden: boolean;
  gridHeight: number;
  paused: boolean;
}

const probe = (page: Page): Promise<Probe> =>
  page.evaluate(() => {
    const tf = (
      window as unknown as {
        tabframe: {
          state: {
            tasks: Map<string, { index: number; status: string }>;
          };
          tiles: {
            paintedCount: number;
            flags: Map<string, string>;
            stats: { inFlight: number };
          };
          demo: { paused: boolean; done: number };
        };
      }
    ).tabframe;
    const canvas = document.querySelector<HTMLCanvasElement>("#tiles");
    const ctx = canvas?.getContext("2d");
    const seen = new Set<string>();
    if (canvas && ctx) {
      for (let i = 0; i < 20; i++)
        for (let j = 0; j < 12; j++) {
          const d = ctx.getImageData(
            Math.floor(((i + 0.5) * canvas.width) / 20),
            Math.floor(((j + 0.5) * canvas.height) / 12),
            1,
            1,
          ).data;
          seen.add(`${d[0]},${d[1]},${d[2]}`);
        }
    }
    const grid = document.querySelector<HTMLCanvasElement>("#grid");
    const tasks = [...tf.state.tasks.values()];
    return {
      tasks: tasks.length,
      placedBeyondFirstPage: tasks.some((t) => t.index >= 256),
      painted: tf.tiles.paintedCount,
      flags: [...tf.tiles.flags.entries()],
      inFlight: tf.tiles.stats.inFlight,
      done: tf.demo.done,
      colors: seen.size,
      gridHidden: grid?.hidden ?? true,
      gridHeight: grid?.height ?? 0,
      paused: tf.demo.paused,
    };
  });

const waitPaused = async (page: Page) => {
  await page.waitForSelector("body[data-demo-paused]", { timeout: 90_000 });
  await page.waitForFunction(
    () =>
      (window as unknown as { tabframe: { tiles: { stats: { inFlight: number } } } }).tabframe.tiles
        .stats.inFlight === 0,
    null,
    { timeout: 30_000 },
  );
};

test("demo: tiles land verified on the canvas, the grid and counters follow the story", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.goto("/?demo=1&speed=12&pause=300");
  await expect(page.locator("#machine")).toHaveText("live · demo");
  await waitPaused(page);
  await expect(page.locator("#exec")).toHaveText("mandelbrot · render · 300/640");
  const p = await probe(page);
  expect(p.paused).toBe(true);
  expect(p.done).toBe(300);
  // The stage event carried 256 rows; the rest were placed from their ids.
  expect(p.tasks).toBeGreaterThanOrEqual(300);
  expect(p.placedBeyondFirstPage).toBe(true);
  // Every finished tile but the scrambled one was fetched, re-hashed, and painted.
  expect(p.flags).toEqual([[p.flags[0]?.[0] ?? "", "bad-hash"]]);
  expect(p.painted).toBe(299);
  expect(p.colors).toBeGreaterThan(12);
  expect(p.gridHidden).toBe(false);
  expect(p.gridHeight).toBeGreaterThan(0);
  // Counters mirror the core's: the planner's task counts as done too (300 tiles + 1 plan), one
  // mismatch, twins from the straggler beats, reassignments from kill half.
  await expect(page.locator('[data-counter="done"] b')).toHaveText("301");
  await expect(page.locator('[data-counter="mismatched"] b')).toHaveText("1");
  const speculated = Number(await page.locator('[data-counter="speculated"] b').textContent());
  expect(speculated).toBeGreaterThanOrEqual(2);
  const reassigned = Number(await page.locator('[data-counter="reassigned"] b').textContent());
  expect(reassigned).toBeGreaterThanOrEqual(1);
  await expect(page.locator("#activity")).toContainText("killHalf: n2 core-2 n6");
  await expect(page.locator("#activity")).toContainText("results disagree");
  await expect(page.locator("#counts")).toHaveText("5 nodes · 4 hosts");
  await expect(page.locator("#nodes tbody tr")).toHaveCount(5);
  await expect(page.locator("#queue")).toContainText("wordcount e39 · person");
  await expect(page.locator("#tileStats")).toHaveText("299 painted · 1 refused · 0 fetching");
  // Controls reach the demo's control plane even while it is paused.
  await page.click("#killHalf");
  await expect(page.locator("#activity li").first()).toContainText(/^\d\d:\d\d:\d\d killHalf: \S+/);
  await page.click("#redundancy");
  await expect(page.locator("#activity li").first()).toContainText("setRedundancy");
  await expect(page.locator("#redundancy")).toBeChecked();
});

test("demo: the control plane rotates mid-frame and the picture survives the new generation", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.goto("/?demo=1&speed=12&pause=600");
  await expect(page.locator("#gen")).toHaveText("gen 7");
  await waitPaused(page);
  await expect(page.locator("#gen")).toHaveText("gen 8");
  await expect(page.locator("#activity")).toContainText("rotating to generation 8");
  await expect(page.locator("#notice")).toBeHidden();
  const p = await probe(page);
  expect(p.done).toBe(600);
  expect(p.painted).toBe(599);
  expect(p.tasks).toBe(640);
  await expect(page.locator("#exec")).toHaveText("mandelbrot · render · 600/640");
});

test("live: cluster controls go over the observer socket and the machine answers", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#machine")).toHaveText(/live/);
  await expect(page.locator("#exec")).toHaveText("idle");
  await expect(page.locator("#queue")).toContainText("empty");
  await expect(page.locator("#counts")).toHaveText("1 nodes · 1 hosts", { timeout: 15_000 });
  await page.click("#spawn1");
  await expect(page.locator("#counts")).toHaveText("2 nodes · 1 hosts");

  // resumeAll with nothing frozen still comes back as applied.
  await page.click("#resumeAll");
  await expect(page.locator("#activity")).toContainText("resumeAll");
  // The redundancy toggle is applied at once here, echoed by the machine, and carried by the next
  // snapshot: a reload shows it still on.
  await page.click("#redundancy");
  await expect(page.locator("#redundancy")).toBeChecked();
  await expect(page.locator("#activity")).toContainText("setRedundancy");
  await expect(page.locator("#machine")).toHaveText(/live/);
  await page.reload();
  await expect(page.locator("#machine")).toHaveText(/live/);
  await expect(page.locator("#redundancy")).toBeChecked();
  await page.click("#redundancy");
  await expect(page.locator("#redundancy")).not.toBeChecked();
  // Kill half names its victims across the cluster.
  await expect(page.locator("#counts")).toHaveText(/nodes · 1 hosts/);
  await page.click("#killHalf");
  await expect(page.locator("#activity")).toContainText(/killHalf: \S+/);
  await expect(page.locator("#machine")).toHaveText(/live/);
  // Stop holds the loop and swaps the button for Start; Start swaps it back (WP6.1).
  await expect(page.locator("#start")).toBeHidden();
  await page.click("#stop");
  await expect(page.locator("#activity")).toContainText("stop");
  await expect(page.locator("#exec")).toHaveText("idle");
  await expect(page.locator("#loop")).toHaveText("loop · held by Stop");
  await expect(page.locator("#start")).toBeVisible();
  await expect(page.locator("#stop")).toBeHidden();
  // The page says what its control did (WP7.1, rule R2).
  await expect(page.locator("#notice")).toContainText("the loop is held until Start");
  await page.reload();
  await expect(page.locator("#machine")).toHaveText(/live/);
  await expect(page.locator("#start")).toBeVisible(); // the snapshot carries it
  await page.click("#start");
  await expect(page.locator("#stop")).toBeVisible();
  await expect(page.locator("#exec")).toHaveText("idle");
  await expect(page.locator("#loop")).toHaveText("loop · running");
});
