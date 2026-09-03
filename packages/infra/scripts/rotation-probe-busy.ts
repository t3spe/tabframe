// WP6.7: what a dashboard sees across a rotation on a *busy* machine — two real dashboards with
// spawned nodes, the page-visible machine state sampled four times a second, and the rotate
// function's own log for the same window. Chasing the "asleep" banner the demo saw at the start
// of a rotation.
//   node packages/infra/scripts/rotation-probe-busy.ts
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { chromium, type Page } from "@playwright/test";
import { maskAccount } from "./mask.ts";

const region = process.env.AWS_REGION ?? "us-west-2";
const cfn = new CloudFormationClient({ region });
const out = async (stack: string) =>
  Object.fromEntries(
    (
      (await cfn.send(new DescribeStacksCommand({ StackName: stack }))).Stacks?.[0]?.Outputs ?? []
    ).map((o) => [o.OutputKey ?? "", o.OutputValue ?? ""]),
  );
const core = await out("TabframeCore");
const fleet = await out("TabframeFleet");
const origin = core.WebOrigin ?? "";
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
const mask = (s: string) => maskAccount(s).replace(/microvm-[0-9a-f-]{36}/g, "<microvm-id>");

type Sample = { gen: string; machine: string; banner: string | null; exec: string; state: unknown };
async function sample(page: Page): Promise<Sample> {
  return page.evaluate(() => {
    const text = (sel: string) => document.querySelector(sel)?.textContent?.trim() ?? "";
    const banner = document.getElementById("machineBanner");
    const tf = (
      window as unknown as {
        tabframe?: { state: { machine: unknown; sleeping: unknown; rotation: unknown } };
      }
    ).tabframe;
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
const lambda = new LambdaClient({ region });
const invoked = lambda.send(
  new InvokeCommand({
    FunctionName: fleet.RotateFunctionName ?? "tabframe-rotate",
    InvocationType: "RequestResponse",
    Payload: new TextEncoder().encode(JSON.stringify({ reason: "probe-busy" })),
  }),
);
console.log(`${stamp()} rotate invoked`);
const result = await invoked;
console.log(
  `${stamp()} rotate returned: ${mask(new TextDecoder().decode(result.Payload ?? new Uint8Array())).slice(0, 200)}`,
);
await page.waitForTimeout(40_000);
clearInterval(sampler);
for (const l of log) console.log(mask(l));

// The rotate function's log for the window: `aws logs filter-log-events` after this run.
console.log(`window ${rotateStarted.toISOString()} → ${new Date().toISOString()}`);
await browser.close();
