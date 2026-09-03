import { spawn } from "node:child_process";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";

// WP4.4: the demo script of design §13, run unattended against the deployed machine in the order
// the video follows: one tab plus two cloud cores rendering → two more tabs → spawn ten (bounded by
// cores, said on screen) → kill half → freeze half → throttle half → redundancy on → editor: change
// the palette, compile in the browser, launch → word count: three stages and a bar chart → a
// rotation: banner, reconnect, render continues → ledger and files panels. Skipped locally: it
// wants the seeded programs, cloud cores, and a real rotation, none of which the Playwright control
// plane has. `mise run demo` points it at the machine; TABFRAME_VIDEO=1 records the browser.
const url = process.env.TABFRAME_URL;
test.skip(!url, "needs a deployed machine (TABFRAME_URL)");
test.use({
  video: process.env.TABFRAME_VIDEO ? "on" : "off",
  viewport: { width: 1440, height: 1000 },
});

const counter = (page: Page, name: string): Promise<number> =>
  page
    .locator(`[data-counter="${name}"] b`)
    .textContent()
    .then((t) => Number((t ?? "0").replace(/[^\d]/g, "") || "0"));
const counts = (page: Page): Promise<{ nodes: number; hosts: number }> =>
  page
    .locator("#counts")
    .textContent()
    .then((t) => {
      const m = /(\d+) nodes · (\d+) hosts/.exec(t ?? "");
      return { nodes: Number(m?.[1] ?? 0), hosts: Number(m?.[2] ?? 0) };
    });
const generation = (page: Page): Promise<number> =>
  page
    .locator("#gen")
    .textContent()
    .then((t) => Number(/gen (\d+)/.exec(t ?? "")?.[1] ?? "0"));
const beat = (name: string) =>
  console.log(`[demo] ${new Date().toISOString().slice(11, 19)} ${name}`);

/** The burst of joins floods the observer into a resubscribe; let the socket come back first. */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(3_000);
  await expect(page.locator("#machine")).toHaveText(/live/, { timeout: 30_000 });
}

async function openTab(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#machine")).toHaveText(/live/, { timeout: 120_000 });
  return page;
}

/** The same rotation the hourly rule runs (`mise run rotate`), started while the page watches. */
function rotateInBackground(): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn("node", ["packages/fleet/scripts/rotate.ts"], {
      stdio: "ignore",
      env: process.env,
    });
    child.on("exit", (code) => resolve(code));
    child.on("error", () => resolve(null));
  });
}

test("the demo script runs unattended against the deployed machine", async ({ context, page }) => {
  test.setTimeout(900_000);

  // ---- 1. one tab, and the cloud cores the machine launches for it ------------------------------
  // Back-to-back repetitions: the previous run's dozen sockets are still closing at the endpoint,
  // which counts connections per MicroVM (WP4.5); a person would not reopen the page that fast.
  if (test.info().repeatEachIndex > 0) await page.waitForTimeout(15_000);
  beat("open the dashboard");
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#machine")).toHaveText(/live/, { timeout: 120_000 });
  await expect(page.locator("#gen")).toHaveText(/gen \d+/, { timeout: 30_000 });
  const startGeneration = await generation(page);
  // The default loop starts a frame as soon as someone watches; the fleet adds two cores.
  await expect(page.locator("#exec")).toContainText("mandelbrot", { timeout: 120_000 });
  await expect
    .poll(() => counts(page).then((c) => c.hosts), { timeout: 150_000 })
    .toBeGreaterThanOrEqual(3);
  beat(`rendering with ${JSON.stringify(await counts(page))}`);
  await expect.poll(() => counter(page, "done"), { timeout: 120_000 }).toBeGreaterThan(10);

  // ---- 2. another real tab -------------------------------------------------------------------------
  // The script says two more; with the endpoint's sixteen connections (WP4.5) one more is what
  // leaves room for the reconnects the beats below cause — see the spawn note.
  beat("another tab");
  const before = await counts(page);
  const tab2 = await openTab(context);
  await expect
    .poll(() => counts(page).then((c) => c.hosts), { timeout: 60_000 })
    .toBeGreaterThanOrEqual(before.hosts + 1);

  // ---- 3. spawn more, bounded by what this browser reports — and by the endpoint -------------------
  // The script says ten; the MicroVM endpoint allows 16 connections in all (WP4.5): two
  // dashboards, their two nodes, and two cores are six, so four more nodes here keeps the machine
  // at ten with room for the reconnects the beats below cause. Runs that spawned ten, then six,
  // saw the dashboard's own socket refused and a control lost or held past its window.
  beat("spawn four");
  const hint = page.locator("#spawnHint");
  await expect(hint).toHaveAttribute("data-cores", /^\d+$/);
  await expect(hint).toContainText(/This browser reports \d+ cores?/);
  const nodesBefore = (await counts(page)).nodes;
  for (let i = 0; i < 4; i++) await page.click("#spawn1");
  await expect
    .poll(() => counts(page).then((c) => c.nodes), { timeout: 60_000 })
    .toBeGreaterThanOrEqual(nodesBefore + 3);
  await settle(page);
  beat(`cluster ${JSON.stringify(await counts(page))}`);

  // ---- 4. kill half: work is taken back or its twins carry on -------------------------------------
  beat("kill half");
  const alive = (await counts(page)).nodes;
  await page.click("#killHalf");
  // A click can still land in a reconnect the page hides; a person would click again, so does
  // the script, and says what the page said about the first one.
  // The page holds a control for ten seconds across a reconnect; only after that is the click
  // known to be lost (a second click before then once killed half of the half).
  const applied = await expect(page.locator("#activity"))
    .toContainText(/killHalf: \S+/, { timeout: 30_000 })
    .then(
      () => true,
      () => false,
    );
  if (!applied) {
    beat(
      `kill half not applied in 30 s: notice "${await page.locator("#notice").textContent()}", machine "${await page.locator("#machine").textContent()}"; clicking again`,
    );
    await page.click("#killHalf");
  }
  await expect(page.locator("#activity")).toContainText(/killHalf: \S+/, { timeout: 30_000 });
  await expect
    .poll(() => counts(page).then((c) => c.nodes), { timeout: 30_000 })
    .toBeLessThan(alive);
  await expect(page.locator('#legend .legend-item[data-state="released"]')).toBeVisible();
  // What the victims held decides whether work is seen taken back or twinned; reported, not
  // required (the frame's completion below is the requirement).
  await page.waitForTimeout(3_000);
  beat(
    `after kill half: reassigned ${await counter(page, "reassigned")}, speculated ${await counter(page, "speculated")}, ${JSON.stringify(await counts(page))}`,
  );

  // ---- 5. freeze half: frozen workers fall silent and are declared gone ----------------------------
  beat("freeze half");
  await page.click("#freezeHalf");
  await expect(page.locator("#activity")).toContainText(/freezeHalf: \S+/, { timeout: 20_000 });
  // The victims are named; each falls silent and is declared gone (a frozen core's MicroVM is
  // terminated and replaced, so the node count alone says nothing).
  // The activity text runs the notes together; the note ends where the next timestamp begins.
  const frozen =
    /freezeHalf: ([^\n]*)/.exec((await page.locator("#activity").textContent()) ?? "")?.[1] ?? "";
  const victims = (frozen.split(/\d\d:\d\d:\d\d/)[0] ?? "").match(/n\d+/g) ?? [];
  beat(`frozen: ${victims.join(" ")}`);
  expect(victims.length).toBeGreaterThan(0);
  await expect
    .poll(
      async () => {
        const ids = await page.locator("#nodes tbody tr td:first-child").allTextContents();
        return victims.filter((v) => ids.some((t) => t.startsWith(v))).length;
      },
      { timeout: 60_000 },
    )
    .toBe(0);

  // ---- 6. throttle half: slow workers get twins, and the picture still completes ------------------
  beat("throttle half");
  // Replace what was lost so there is something to throttle and something to race it.
  for (let i = 0; i < 3; i++) await page.click("#spawn1");
  await expect
    .poll(() => counts(page).then((c) => c.nodes), { timeout: 60_000 })
    .toBeGreaterThanOrEqual(4);
  await settle(page);
  await page.click("#throttleHalf");
  await expect(page.locator("#activity")).toContainText(/throttleHalf: \S+/, { timeout: 20_000 });
  // Twins appear when a throttled attempt runs past its deadline; usual, not guaranteed within a
  // frame, so it is reported rather than required.
  const twins = await expect
    .poll(() => counter(page, "speculated"), { timeout: 60_000 })
    .toBeGreaterThanOrEqual(1)
    .then(
      () => true,
      () => false,
    );
  beat(`throttle half: twins ${twins ? "seen" : "not seen within a minute"}`);
  await page.click("#resumeAll");
  await expect(page.locator("#activity")).toContainText("resumeAll", { timeout: 20_000 });

  // ---- 7. redundancy on: every tile computed twice, the bytes agree ----------------------------------
  beat("redundancy on");
  await settle(page);
  await page.click("#redundancy");
  await expect(page.locator("#redundancy")).toBeChecked({ timeout: 20_000 });
  await expect(page.locator("#activity")).toContainText("setRedundancy", { timeout: 20_000 });
  // Agreement is set when a task is created, so the verified count climbs with the next frame;
  // the machine's state is logged along the way in case it does not.
  const verifiedAt = Date.now();
  await expect
    .poll(
      async () => {
        const verified = await counter(page, "verified");
        if ((Date.now() - verifiedAt) % 30_000 < 2_500) {
          beat(
            `waiting for verified tiles: exec "${await page.locator("#exec").textContent()}", machine "${await page.locator("#machine").textContent()}", done ${await counter(page, "done")}, ${JSON.stringify(await counts(page))}`,
          );
        }
        return verified;
      },
      { timeout: 240_000, intervals: [2_000] },
    )
    .toBeGreaterThanOrEqual(1);
  await expect(page.locator('[data-counter="mismatched"] b')).toHaveText("0");
  await page.click("#redundancy");
  await expect(page.locator("#redundancy")).not.toBeChecked();

  // ---- 7b. stop and start: a person makes the machine idle, then lets the loop run again ----------
  beat("stop");
  await settle(page);
  await page.click("#stop");
  await expect(page.locator("#start")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#exec")).toContainText("stopped", { timeout: 30_000 });
  const execAtStop = (await page.locator("#exec").textContent()) ?? "";
  await page.waitForTimeout(8_000);
  const execLater = (await page.locator("#exec").textContent()) ?? "";
  beat(`stopped: "${execAtStop}" → "${execLater}"`);
  expect(execLater).toContain("stopped");
  await page.click("#start");
  await expect(page.locator("#stop")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#exec")).toContainText("mandelbrot · ", { timeout: 60_000 });
  await expect(page.locator("#exec")).not.toContainText("stopped", { timeout: 60_000 });
  beat("started again");

  // ---- 8. the editor: change the palette cycle, compile in the browser, launch ---------------------
  beat("editor");
  await page.click("#openEditor");
  await expect(page.locator("#editor")).toBeVisible();
  await expect(page.locator("#editorStatus")).toHaveText(/ready in/, { timeout: 180_000 });
  const source = await page.locator("#source").inputValue();
  expect(source).toContain("const CYCLE: f64 = 48.0;");
  await page
    .locator("#source")
    .fill(source.replace("const CYCLE: f64 = 48.0;", "const CYCLE: f64 = 24.0;"));
  await page.click("#compile");
  await expect(page.locator("#editorStatus")).toHaveText(/compiled in \d+ ms/, {
    timeout: 180_000,
  });
  await expect(page.locator("#diagnostics li")).toHaveCount(0);
  await expect(page.locator("#launch")).toBeEnabled();
  // Its own name: the shipped one is reserved for the image (WP4.9).
  await page.locator("#programName").fill("mandelbrot-palette");
  await page.locator("#programView").selectOption("tiles");
  await page.locator("#programParams").fill('{"palette":"fire","preset":0}');
  await page.click("#launch");
  await expect(page.locator("#launchInfo")).toContainText(/queued as|running as/, {
    timeout: 60_000,
  });
  await page.click("#closeEditor");
  // A person's launch goes ahead of the loop's continuations and runs next.
  await expect(page.locator("#exec")).toContainText("mandelbrot-palette", { timeout: 240_000 });
  await expect.poll(() => counter(page, "done"), { timeout: 180_000 }).toBeGreaterThan(50);
  beat("the edited program renders");

  // ---- 9. word count: three stages and a bar chart ----------------------------------------------------
  beat("word count");
  await expect(page.locator('[data-launch="wordcount"]')).toBeVisible({ timeout: 30_000 });
  await page.click('[data-launch="wordcount"]');
  await page.click('[data-launch-go="wordcount"]');
  // Word count waits for the running frame, then runs its three stages in seconds; a person's
  // result then holds the stage for twenty seconds (core, HUMAN_RESULT_HOLD_MS). One poll follows
  // the page through all of it and logs every change, so a miss says where it went.
  const stageOf = () =>
    page.evaluate(() => {
      const text = (sel: string) => document.querySelector(sel)?.textContent?.trim() ?? "";
      return {
        exec: text("#exec"),
        stages: document.querySelectorAll("#strip .stage").length,
        bars: document.querySelectorAll("#result .bars .bar-row").length,
      };
    });
  let last = "";
  let seenStages = 0;
  await expect
    .poll(
      async () => {
        const s = await stageOf();
        const line = `${s.exec} · stages ${s.stages} · bars ${s.bars}`;
        if (line !== last) {
          beat(`word count: ${line}`);
          last = line;
        }
        if (s.exec.startsWith("wordcount")) seenStages = Math.max(seenStages, s.stages);
        return s.exec.startsWith("wordcount · done") && s.bars > 0;
      },
      { timeout: 300_000, intervals: [500] },
    )
    .toBe(true);
  expect(seenStages).toBeGreaterThanOrEqual(3); // the strip shows a fold row while folding
  await expect(page.locator("#result .bar-row").first()).toHaveAttribute("data-label", /\w+/);
  await expect(page.locator("#files")).toContainText("/in/corpus.txt", { timeout: 15_000 });
  beat("word count drew its bars");

  // ---- 10. a rotation: banner, reconnect, the render continues --------------------------------------
  beat("rotation");
  const rotation = rotateInBackground();
  const banner = page.locator("#machineBanner");
  // The rotating banner's countdown is under two seconds, so what the banner said is collected
  // while the generation advances rather than asserted at one instant; a banner of any other
  // kind is logged with what the page knew of the machine.
  const bannersSeen = new Map<string, string>();
  await expect
    .poll(
      async () => {
        if (await banner.isVisible()) {
          const kind = (await banner.getAttribute("data-kind")) ?? "?";
          if (!bannersSeen.has(kind)) {
            const machine = await page.evaluate(() =>
              JSON.stringify(
                (window as unknown as { tabframe: { state: { machine: unknown } } }).tabframe.state
                  .machine,
              ),
            );
            bannersSeen.set(
              kind,
              `${(await banner.textContent())?.slice(0, 80)} · machine ${machine}`,
            );
            beat(`banner ${kind}: ${bannersSeen.get(kind)}`);
          }
        }
        return (await generation(page)) > startGeneration;
      },
      { timeout: 240_000, intervals: [200] },
    )
    .toBe(true);
  expect([...bannersSeen.keys()]).toContain("rotating");
  await expect(page.locator("#machine")).toHaveText(/live/, { timeout: 120_000 });
  await expect(banner).toBeHidden({ timeout: 120_000 });
  // The picture stayed on screen, the tabs are back, and the machine keeps working.
  await expect(page.locator("#tiles")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => counts(page).then((c) => c.nodes), { timeout: 120_000 })
    .toBeGreaterThanOrEqual(1);
  await expect(page.locator("#exec")).not.toHaveText("idle", { timeout: 180_000 });
  expect(await rotation).toBe(0);
  beat(`generation ${await generation(page)}, ${JSON.stringify(await counts(page))}`);

  // ---- 11. the ledger and files panels: hashes everywhere, no bytes in the control plane -----------
  beat("ledger and files");
  await expect(page.locator("#ledgerNote")).toContainText("hashes, not bytes");
  await expect(page.locator("#ledger tbody tr[data-hash]").first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.locator("#ledger tbody tr[data-hash]").first()).toHaveAttribute(
    "data-hash",
    /^[0-9a-f]{64}$/,
  );
  await expect(page.locator("#filesNote")).toContainText("named by its hash");
  // After the rotation the loop is on a fresh frame; its filesystem exists once the stage folds.
  await expect(page.locator("#filesRoot")).not.toHaveText("—", { timeout: 180_000 });
  await expect(page.locator("#files")).toContainText("/program.wasm", { timeout: 180_000 });

  await tab2.close();
  beat("done");
});
