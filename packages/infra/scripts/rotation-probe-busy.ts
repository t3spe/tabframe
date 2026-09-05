// What a dashboard sees across a rotation on a *busy* machine: two real dashboards with spawned
// nodes, the page-visible machine state sampled four times a second, and the window to read the
// rotate function's log for.
//   node packages/infra/scripts/rotation-probe-busy.ts
import { chromium, type Page } from "@playwright/test";
import { maskMicrovmIds, maskSecrets } from "../../fleet/src/mask.ts";
import { operatorClients, stackOutputs } from "../../fleet/src/operator.ts";

const core = await stackOutputs("TabframeCore");
const fleet = await stackOutputs("TabframeFleet");
const origin = core.WebOrigin ?? "";
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
const mask = (s: string) => maskMicrovmIds(maskSecrets(s));

type Sample = { gen: string; machine: string; banner: string | null; exec: string; state: unknown };
async function sample(page: Page): Promise<Sample> {
  return page.evaluate(() => {
    const text = (sel: string) => document.querySelector(sel)?.textContent?.trim() ?? "";
    const banner = document.getElementById("machineBanner");
    const tf = window.tabframe;
    return {
      gen: text("#gen"),
      machine: text("#machine"),
      banner:
        banner && !banner.hidden
          ? `${banner.dataset.kind}: ${banner.textContent?.slice(0, 60)}`
          : null,
      exec: text("#exec"),
      state: tf
        ? { machine: tf.state.machine, sleeping: tf.state.sleeping, rotation: tf.state.rotation }
        : null,
    };
  });
}

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(origin, { waitUntil: "domcontentloaded" });
await page.locator("#machine").filter({ hasText: /live/ }).waitFor({ timeout: 120_000 });
for (let i = 0; i < 3; i++) await page.click("#spawn1");
const tab2 = await context.newPage();
await tab2.goto(origin, { waitUntil: "domcontentloaded" });
await tab2.locator("#machine").filter({ hasText: /live/ }).waitFor({ timeout: 120_000 });
await page.waitForTimeout(8_000);
console.log(`${stamp()} before: ${JSON.stringify(await sample(page))}`);

let last = "";
const log: string[] = [];
const sampler = setInterval(() => {
  void sample(page)
    .then((s) => {
      const line = JSON.stringify({
        gen: s.gen,
        machine: s.machine,
        banner: s.banner,
        exec: s.exec.slice(0, 40),
        awake: (s.state as { machine?: { awake?: boolean; reason?: string | null } } | null)
          ?.machine?.awake,
        reason: (s.state as { machine?: { reason?: string | null } } | null)?.machine?.reason,
      });
      if (line !== last) {
        last = line;
        log.push(`${stamp()} ${line}`);
      }
    })
    .catch(() => {});
}, 250);

const rotateStarted = new Date();
const { invoker } = operatorClients();
const invoked = invoker.invokeSync(fleet.RotateFunctionName ?? "tabframe-rotate", {
  reason: "probe-busy",
});
console.log(`${stamp()} rotate invoked`);
const result = await invoked;
console.log(`${stamp()} rotate returned: ${mask(JSON.stringify(result)).slice(0, 200)}`);
await page.waitForTimeout(40_000);
clearInterval(sampler);
for (const l of log) console.log(mask(l));

// The rotate function's log for the window: `aws logs filter-log-events` after this run.
console.log(`window ${rotateStarted.toISOString()} → ${new Date().toISOString()}`);
await browser.close();
