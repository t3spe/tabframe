// M1 verification runbook (plan WP1.10): the deployed machine renders a Mandelbrot frame with
// browser tabs only, survives "kill half" mid-frame, and every tile hashes to the golden. Also
// checks that tab uploads reached the bucket (a tile reads back through CloudFront with the right
// hash) and that the control plane wrote its snapshot to S3. Prints one line per check; tokens
// and account ids never reach stdout. Results are copied into docs/m1-verification.md.
//   node packages/infra/scripts/verify-m1.ts [--tabs 3] [--kill-at 120] [--timeout 600]

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { chromium } from "@playwright/test";
import { PROTOCOL_VERSION } from "@tabframe/protocol";
import { fetchSession, type Session, socketProtocols } from "../../node/src/session.ts";
import { maskAccount } from "./mask.ts";

const region = process.env.AWS_REGION ?? "us-west-2";
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(name);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const tabs = Number(arg("--tabs", "3"));
const killAt = Number(arg("--kill-at", "120"));
const timeoutS = Number(arg("--timeout", "600"));
const root = path.resolve(import.meta.dirname, "../../..");
const golden = JSON.parse(
  readFileSync(path.join(root, "programs/mandelbrot/goldens.json"), "utf8"),
) as {
  params: Record<string, unknown>;
  taskCount: number;
  hashes: string[];
};

const results: Array<{ check: string; result: string; pass: boolean | null }> = [];
function record(check: string, result: string, pass: boolean | null = null): void {
  results.push({ check, result, pass });
  console.log(`${pass === null ? "·" : pass ? "✓" : "✗"} ${check}: ${maskAccount(result)}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;

// ---- outputs -------------------------------------------------------------------------------------
const cfn = new CloudFormationClient({ region });
async function outputs(stack: string): Promise<Record<string, string>> {
  const r = await cfn.send(new DescribeStacksCommand({ StackName: stack }));
  return Object.fromEntries(
    (r.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey ?? "", o.OutputValue ?? ""]),
  );
}
const fleet = await outputs("TabframeFleet");
const core = await outputs("TabframeCore");
const sessionUrl = fleet.SessionUrl ?? "";
const webOrigin = core.WebOrigin ?? "";
const snapshotBucket = core.SnapshotBucketName ?? "";
if (!sessionUrl || !webOrigin || !snapshotBucket)
  throw new Error("stack outputs missing; deploy first");

// ---- 1. session ----------------------------------------------------------------------------------
let session: Session = { kind: "off" };
for (let i = 0; i < 60; i++) {
  session = await fetchSession(sessionUrl, (u) => fetch(u));
  if (session.kind === "on") break;
  if (session.kind === "off") throw new Error("the machine is off; run `mise run up`");
  await sleep(session.retryAfterMs);
}
if (session.kind !== "on") throw new Error("control plane did not come up");
record(
  "session",
  `on, generation ${session.generation}, endpoint assigned, store base ${session.storeBase.includes("/blob") ? "under the web origin" : "elsewhere"}`,
  true,
);

// ---- 2. observer socket through the proxy --------------------------------------------------------
type Ev = { t: string; [k: string]: unknown };
const events: Ev[] = [];
const waiters: Array<{ pred: (e: Ev) => boolean; resolve: (e: Ev) => void }> = [];
const on = session;
const ws = await new Promise<WebSocket>((resolve, reject) => {
  const s = new WebSocket(`${on.endpoint}/observer`, socketProtocols(on.token));
  s.onopen = () => {
    s.send(JSON.stringify({ t: "subscribe", v: PROTOCOL_VERSION, gen: on.generation }));
    resolve(s);
  };
  s.onerror = () => reject(new Error("observer socket failed"));
  s.onmessage = (m) => {
    const ev = JSON.parse(String(m.data)) as Ev;
    events.push(ev);
    for (const w of waiters.splice(0)) w.pred(ev) ? w.resolve(ev) : waiters.push(w);
  };
});
const ping = setInterval(() => {
  if (ws.readyState === ws.OPEN)
    ws.send(JSON.stringify({ t: "ping", v: PROTOCOL_VERSION, gen: on.generation }));
}, 1_500);
const waitFor = (pred: (e: Ev) => boolean, ms: number, what: string) =>
  new Promise<Ev>((resolve, reject) => {
    const found = events.find(pred);
    if (found) return resolve(found);
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `timed out waiting for ${what} (${events.length} events, last ${events.at(-1)?.t})`,
          ),
        ),
      ms,
    );
    waiters.push({
      pred,
      resolve: (e) => {
        clearTimeout(timer);
        resolve(e);
      },
    });
  });
const send = (msg: Record<string, unknown>) =>
  ws.send(JSON.stringify({ ...msg, v: PROTOCOL_VERSION, gen: on.generation }));

const snapshot = (await waitFor((e) => e.t === "snapshot", 15_000, "snapshot")) as Ev & {
  programs?: Array<{ name: string; view: string }>;
  nodes?: unknown[];
};
record(
  "seeded programs",
  `${(snapshot.programs ?? []).map((p) => `${p.name} (${p.view})`).join(", ") || "none"}; ${snapshot.nodes?.length ?? 0} nodes before ours`,
  (snapshot.programs ?? []).some((p) => p.name === "mandelbrot"),
);

// ---- 3. browser tabs -----------------------------------------------------------------------------
const browser = await chromium.launch();
const pages = [];
for (let i = 0; i < tabs; i++) {
  const page = await browser.newPage();
  page.on("pageerror", (err) =>
    console.log(`  [tab ${i}] page error: ${String(err).slice(0, 120)}`),
  );
  await page.goto(webOrigin, { waitUntil: "domcontentloaded" });
  // The page spawns one node once it is live; one more per tab makes two.
  await page.locator("#machine").filter({ hasText: /live/ }).waitFor({ timeout: 60_000 });
  await page.locator("#spawn1").click({ timeout: 30_000 });
  pages.push(page);
}
const wanted = tabs * 2;
const joinedAt = Date.now();
while (events.filter((e) => e.t === "nodeJoined").length < wanted && Date.now() - joinedAt < 60_000)
  await sleep(500);
const joined = events.filter((e) => e.t === "nodeJoined").length;
record(
  "tab nodes joined",
  `${joined} of ${wanted} (${tabs} tabs × 2 nodes) after ${elapsed()}`,
  joined >= wanted,
);

// ---- 4. the frame, with kill half in the middle -------------------------------------------------
const started = (await waitFor(
  (e) => e.t === "executionStarted",
  60_000,
  "executionStarted",
)) as Ev & { execution: { executionId: string; params: Record<string, unknown> } };
const executionId = started.execution.executionId;
record(
  "default loop launched",
  `execution ${executionId} with params ${JSON.stringify(started.execution.params)}`,
  JSON.stringify(Object.entries(started.execution.params).sort()) ===
    JSON.stringify(Object.entries(golden.params).sort()),
);
const tilesDone = () =>
  new Set(
    events.filter((e) => e.t === "taskDone" && e.place !== null).map((e) => e.taskId as string),
  ).size;
const killDeadline = Date.now() + timeoutS * 1000;
while (tilesDone() < killAt && Date.now() < killDeadline) await sleep(250);
const beforeKill = tilesDone();
send({ t: "killHalf" });
const applied = (await waitFor(
  (e) => e.t === "controlApplied" && e.op === "killHalf",
  15_000,
  "killHalf applied",
)) as Ev & { nodeIds: string[] };
await sleep(6_000);
const left = events.filter((e) => e.t === "nodeLeft").length;
const reassigned = events.filter((e) => e.t === "taskReassigned").length;
record(
  "kill half",
  `${applied.nodeIds.length} victims at ${beforeKill} tiles; ${left} nodeLeft, ${reassigned} taskReassigned within 6 s`,
  applied.nodeIds.length >= Math.floor(joined / 2) && left >= applied.nodeIds.length,
);

const outcome = await waitFor(
  (e) => (e.t === "executionDone" || e.t === "executionFailed") && e.executionId === executionId,
  killDeadline - Date.now(),
  "the execution to end",
);
if (outcome.t === "executionFailed") {
  const reasons = [
    ...new Set(events.filter((e) => e.t === "taskFailed").map((e) => String(e.reason))),
  ].slice(0, 3);
  record(
    "frame complete",
    `execution failed: ${String(outcome.reason)}; task failures: ${reasons.join(" | ") || "none"}`,
    false,
  );
  clearInterval(ping);
  ws.close();
  await browser.close();
  process.exit(1);
}
const done = outcome as Ev & { followUp: Record<string, unknown> | null };
const latest = new Map<string, string>();
for (const e of events)
  if (e.t === "taskDone" && e.place !== null) latest.set(e.taskId as string, e.output as string);
const hashes = new Set(latest.values());
const goldenSet = new Set(golden.hashes);
const matching = [...hashes].filter((h) => goldenSet.has(h)).length;
const failed = events.filter((e) => e.t === "taskFailed" || e.t === "executionFailed").length;
record(
  "frame complete",
  `${latest.size} tiles settled in ${elapsed()}, ${matching} of ${golden.taskCount} golden hashes present, ${failed} failures, follow-up ${JSON.stringify(done.followUp)}`,
  latest.size === golden.taskCount && matching === golden.taskCount && failed === 0,
);
const speculated = events.filter((e) => e.t === "taskSpeculated").length;
const verified = events.filter((e) => e.t === "taskVerified").length;
record(
  "scheduler activity",
  `${speculated} speculated, ${verified} verified, ${reassigned} reassigned (before the kill settled) → ${events.filter((e) => e.t === "taskReassigned").length} total`,
  null,
);

// ---- 5. a tile reads back through CloudFront with its hash ---------------------------------------
const sample = [...hashes][0] as string;
const res = await fetch(`${on.storeBase.replace(/\/$/, "")}/${sample}`);
const bytes = new Uint8Array(await res.arrayBuffer());
const actual = createHash("sha256").update(bytes).digest("hex");
record(
  "tab upload reads back",
  `${res.status}, ${bytes.length} bytes, hash ${actual === sample ? "matches" : "differs"}, cache ${res.headers.get("x-cache") ?? "n/a"}`,
  res.status === 200 && actual === sample && bytes.length === 64 * 64 * 4,
);

// ---- 6. the snapshot in S3 -----------------------------------------------------------------------
const s3 = new S3Client({ region });
const list = await s3.send(new ListObjectsV2Command({ Bucket: snapshotBucket, Prefix: "" }));
const objects = list.Contents ?? [];
const latestObj = objects.find((o: { Key?: string }) => o.Key === "latest.json.gz");
const ageS = latestObj?.LastModified
  ? (Date.now() - latestObj.LastModified.getTime()) / 1000
  : Number.NaN;
record(
  "S3 snapshots",
  `${objects.length} objects, latest.json.gz ${latestObj ? `${latestObj.Size} bytes, ${ageS.toFixed(0)} s old` : "missing"}, generation prefix ${objects.some((o: { Key?: string }) => o.Key?.startsWith(`g${on.generation}/`)) ? "present" : "absent"}`,
  latestObj !== undefined && ageS < 120,
);

// ---- 7. continuation while we watch ------------------------------------------------------------
try {
  const next = (await waitFor(
    (e) =>
      e.t === "executionStarted" &&
      (e as Ev & { execution: { executionId: string } }).execution.executionId !== executionId,
    30_000,
    "the next execution",
  )) as Ev & { execution: { params: Record<string, unknown>; human: boolean } };
  record(
    "automatic continuation",
    `next execution started with ${JSON.stringify(next.execution.params)}, human ${next.execution.human}`,
    next.execution.human === false,
  );
} catch (err) {
  record("automatic continuation", String(err), false);
}

clearInterval(ping);
ws.close();
await browser.close();
const passed = results.filter((r) => r.pass === true).length;
const failedChecks = results.filter((r) => r.pass === false).length;
console.log(
  `\n${passed} passed, ${failedChecks} failed, ${results.length - passed - failedChecks} informational; ${elapsed()}`,
);
process.exit(failedChecks ? 1 : 0);
