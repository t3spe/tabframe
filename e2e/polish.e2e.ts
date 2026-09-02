import { expect, type Page, test } from "@playwright/test";

// WP4.1: dashboard polish. Everything here runs against the demo mode, paused at a known tile
// count or held after an execution ends, so nothing depends on the timing of a live render: the
// legend, the flash log, the throughput figure, the spawn hint, the ledger, the rotation banner
// with its countdown, and the sleep banner.

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

const pulseKinds = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    (
      window as unknown as { tabframe: { state: { pulses: { kind: string }[] } } }
    ).tabframe.state.pulses.map((p) => p.kind),
  );

test("demo: legend, flash log, throughput, spawn hint, and the ledger explain the frame", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.goto("/?demo=1&speed=12&pause=300");
  await expect(page.locator("#machine")).toHaveText("live · demo");
  // The spawn hint is sized to this browser before anything runs.
  const hint = page.locator("#spawnHint");
  await expect(hint).toHaveAttribute("data-cores", /^\d+$/);
  await expect(hint).toHaveAttribute("data-default", /^\d+$/);
  await expect(hint).toContainText(/This browser reports \d+ cores?/);
  await expect(hint).toContainText("share those cores");
  await waitPaused(page);

  // The legend names every colour and both overlays.
  await expect(page.locator("#legend .legend-item")).toHaveCount(10);
  for (const state of [
    "pending",
    "assigned",
    "speculated",
    "released",
    "done",
    "verified",
    "mismatch",
    "failed",
    "flash",
    "contested",
  ])
    await expect(page.locator(`#legend .legend-item[data-state="${state}"]`)).toBeVisible();
  await expect(page.locator('#legend [data-state="released"]')).toContainText("taken back");
  await expect(page.locator('#legend [data-state="mismatch"]')).toContainText("recomputing");

  // Kill half at tile 200 took work back from three nodes; the straggler at 40 got a twin; the
  // liar at 90 was retracted. Each left a pulse, the newest of which are on the page.
  await expect(page.locator('#pulses li[data-kind="released"]').first()).toBeVisible();
  await expect(page.locator('#pulses li[data-kind="released"]').first()).toContainText(
    /^\d\d:\d\d:\d\d t\d+ taken back from \S+$/,
  );
  const kinds = await pulseKinds(page);
  expect(kinds).toContain("released");
  expect(kinds).toContain("speculated");
  expect(kinds).toContain("mismatch");

  // The throughput chart and its figure, with the cluster's size.
  await expect(page.locator("#throughputChart")).toBeVisible();
  const figure = page.locator("#throughputFigure");
  await expect(figure).toHaveText(/^\d+\.\d tiles\/s · 5 nodes$/);
  await expect(figure).toHaveAttribute("data-nodes", "5");
  await expect(figure).toHaveAttribute("data-peak", /^[1-9]\d*$/);
  // The next rotation is announced in the header.
  await expect(page.locator("#nextRotation")).toHaveText(/^rotation in 1[89] min$/);

  // The ledger: hashes, sizes, and where the bytes live — never the bytes themselves.
  await expect(page.locator("#ledgerNote")).toContainText("hashes, not bytes");
  const rows = page.locator("#ledger tbody tr[data-hash]");
  await expect(rows).toHaveCount(8);
  await expect(rows.first()).toHaveAttribute("data-hash", /^[0-9a-f]{64}$/);
  await expect(rows.first()).toHaveAttribute("data-size", "16384");
  await expect(rows.first()).toContainText("16.0 KiB");
  await expect(rows.first()).toContainText("demo store");
  await expect(page.locator("#filesNote")).toContainText("named by its hash");
  // No banner: the machine is plainly live.
  await expect(page.locator("#machineBanner")).toBeHidden();
  await expect(page.locator("#notice")).toBeHidden();
});

test("demo: the rotation banner counts down to the next generation", async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto("/?demo=1&speed=12&pause=520");
  await waitPaused(page);
  const banner = page.locator("#machineBanner");
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute("data-kind", "rotating");
  await expect(banner).toHaveAttribute("data-next", "8");
  await expect(page.locator("#rotationGeneration")).toHaveText("8");
  // The demo's clock stops with the pause, so the countdown holds at the announced delay.
  await expect(page.locator("#rotationCountdown")).toHaveText("2.4 s");
  await expect(banner).toContainText("fresh MicroVM");
  await expect(banner).toContainText("Nothing to do");
  // Still the old generation, and the picture stays on screen.
  await expect(page.locator("#gen")).toHaveText("gen 7");
  await expect(page.locator("#tiles")).toBeVisible();
});

test("demo: a machine with nothing to do says it is going to sleep, and why", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/?demo=1&speed=12&program=broken&hold=1");
  await page.waitForSelector("body[data-demo-paused]", { timeout: 90_000 });
  const banner = page.locator("#machineBanner");
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute("data-kind", "sleeping");
  await expect(banner).toContainText("going to sleep");
  await expect(banner).toContainText("an hour without anyone touching the dashboard");
  await expect(banner).toContainText("wakes it");
  // The failure that preceded it is still on the page.
  await expect(page.locator("#failure")).toContainText("trap: unreachable");
});
