import { expect, type Page, test } from "@playwright/test";
import { tf, waitDemoPaused } from "./helpers.ts";

// Dashboard polish. Everything here runs against the demo mode, paused at a known tile count or
// held after an execution ends, so nothing depends on the timing of a live render: the legend, the
// flash log, the throughput figure, the spawn hint, the ledger, the rotation banner with its
// countdown, and the sleep banner.

const pulseKinds = async (page: Page): Promise<string[]> =>
  (await tf(page)).evaluate((d) => d.state.pulses.map((p) => p.kind));

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
  // In the demo the nodes are scripted, and the hint says so; the live page counts CPU threads.
  await expect(hint).toContainText(/Demo: the nodes are scripted inside this page/);
  await expect(hint).toContainText("open the live address to lend real cores");
  await waitDemoPaused(page);

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
  // The status line says what the machine does.
  await expect(page.locator("#notice")).toHaveClass(/sentence/);
  await expect(page.locator("#notice")).toContainText("demo · a scripted cluster inside this page");
});

test("demo: the rotation banner counts down to the next generation", async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto("/?demo=1&speed=12&pause=520");
  await waitDemoPaused(page);
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
  await waitDemoPaused(page);
  const banner = page.locator("#machineBanner");
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute("data-kind", "sleeping");
  await expect(banner).toContainText("going to sleep");
  await expect(banner).toContainText("an hour without anyone touching the dashboard");
  await expect(banner).toContainText("wakes it");
  // The failure that preceded it is still on the page.
  await expect(page.locator("#failure")).toContainText("trap: unreachable");
});

test("demo: nothing changes size — the page's regions keep their boxes from idle to a paused frame", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const selectors = [
    "header",
    ".hero",
    "#stage",
    ".execrow",
    "#strip",
    "#failure",
    ".stage-box",
    "#grid",
    "#pulses",
    "#taskDetail",
    "#counters",
    ".controls",
    "#nodes",
    "aside",
    "#programs",
    "#queue",
    "#ledgerPanel",
    "#activityPanel",
  ];
  const boxes = () =>
    page.evaluate((sels) => {
      const out: Record<string, string> = {};
      for (const sel of sels) {
        const r = document.querySelector(sel)?.getBoundingClientRect();
        if (r) out[sel] = `${Math.round(r.width)}×${Math.round(r.height)}`;
      }
      return out;
    }, selectors);
  await page.goto("/?demo=1&speed=12&pause=300");
  await expect(page.locator("#machine")).toHaveText("live · demo");
  const atStart = await boxes();
  await waitDemoPaused(page);
  const atPause = await boxes();
  expect(atPause).toEqual(atStart);
  // Controls that toggle keep their slot too.
  await page.click("#killHalf");
  await expect(page.locator("#activity")).toContainText(/killHalf/);
  expect(await boxes()).toEqual(atStart);
});

test("demo: the throughput line is crisp on a slow scale; counters, toggle, and flashes fit their rows", async ({
  page,
}) => {
  await page.goto("/?demo=1&speed=12&pause=300");
  await expect(page.locator("#machine")).toHaveText(/live/, { timeout: 30_000 });
  await expect
    .poll(() => page.locator('#counters .chip[data-counter="done"] b').textContent(), {
      timeout: 60_000,
    })
    .not.toMatch(/^(—|0)$/);
  // Drawn at the screen's pixel density: the canvas's pixel box is its CSS box times the ratio.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const c = document.querySelector("#throughputChart") as HTMLCanvasElement;
        const dpr = window.devicePixelRatio || 1;
        return (
          c.width === Math.round(c.clientWidth * dpr) &&
          c.height === Math.round(c.clientHeight * dpr)
        );
      }),
    )
    .toBe(true);
  // The scale is a round number and moves slowly: over five seconds of a steady frame it takes at
  // most two values (one rise as the frame gets going).
  const scales = new Set<string>();
  for (let i = 0; i < 10; i++) {
    scales.add((await page.locator("#throughputChart").getAttribute("data-scale")) ?? "?");
    await page.waitForTimeout(500);
  }
  expect(scales.size).toBeLessThanOrEqual(2);
  for (const v of scales) expect(Number(v)).toBeGreaterThan(0);
  const title = (await page.locator("#throughputChart").getAttribute("title")) ?? "";
  expect(title).toContain("moves at most once a minute");
  // Eight counters, all inside their box — read in one evaluate, since the chips are rebuilt on
  // every state update and a locator can resolve to a detached one between two round trips.
  const fit = await page.evaluate(() => {
    const box = (document.querySelector("#counters") as HTMLElement).getBoundingClientRect();
    return [...document.querySelectorAll("#counters .chip")].map((chip) => {
      const b = chip.getBoundingClientRect();
      return b.width > 0 && b.right <= box.right + 1 && b.bottom <= box.bottom + 1;
    });
  });
  expect(fit).toHaveLength(8);
  expect(fit.every(Boolean)).toBe(true);
  // The redundancy toggle is one line under the buttons; the flashes are one line under the legend.
  const toggle = await page.locator(".toggle-row label").boundingBox();
  expect(toggle?.height ?? 99).toBeLessThan(28);
  const pulses = await page.locator("#pulses").boundingBox();
  expect(pulses?.height ?? 99).toBeLessThan(26);
});
