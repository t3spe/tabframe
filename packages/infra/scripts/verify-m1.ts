// M1 verification runbook: the deployed machine renders a Mandelbrot frame with browser tabs only,
// survives "kill half" mid-frame, and every tile hashes to the golden. Also checks that tab uploads
// reached the bucket (a tile reads back through CloudFront with the right hash) and that the
// control plane wrote its snapshot to S3. Prints one line per check; tokens and account ids never
// reach stdout.
//   node packages/infra/scripts/verify-m1.ts [--tabs 3] [--kill-at 120] [--timeout 600]

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { HeadObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { chromium } from "@playwright/test";
import { stackOutputs } from "../../fleet/src/operator.ts";
import {
  argNumber,
  awaitSession,
  type Ev,
  observe,
  openLendingTabs,
  record,
  sleep,
  summary,
} from "./_runbook.ts";

const tabs = argNumber("--tabs", 3);
const killAt = argNumber("--kill-at", 120);
const timeoutS = argNumber("--timeout", 600);
const root = path.resolve(import.meta.dirname, "../../..");
const golden = JSON.parse(
  readFileSync(path.join(root, "programs/mandelbrot/goldens.json"), "utf8"),
) as {
  params: Record<string, unknown>;
  taskCount: number;
  hashes: string[];
};
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;

// ---- outputs -------------------------------------------------------------------------------------
const fleet = await stackOutputs("TabframeFleet");
const core = await stackOutputs("TabframeCore");
const sessionUrl = fleet.SessionUrl ?? "";
const webOrigin = core.WebOrigin ?? "";
const snapshotBucket = core.SnapshotBucketName ?? "";
if (!sessionUrl || !webOrigin || !snapshotBucket)
  throw new Error("stack outputs missing; deploy first");

// ---- 1. session ----------------------------------------------------------------------------------
const on = await awaitSession(sessionUrl);
record(
  "session",
  `on, generation ${on.generation}, endpoint assigned, store base ${on.storeBase.includes("/blob") ? "under the web origin" : "elsewhere"}`,
  true,
);

// ---- 2. observer socket through the proxy --------------------------------------------------------
const obs = await observe(on);
const { events, waitFor, send } = obs;

const snapshot = (await waitFor((e) => e.t === "snapshot", 15_000, "snapshot")) as Ev & {
  programs?: Array<{ name: string; view: string; bundle: string; addedAt?: number }>;
  execution?: unknown;
  nodes?: unknown[];
};
record(
  "seeded programs",
  `${(snapshot.programs ?? []).map((p) => `${p.name} (${p.view})`).join(", ") || "none"}; ${snapshot.nodes?.length ?? 0} nodes before ours`,
  (snapshot.programs ?? []).some((p) => p.name === "mandelbrot"),
);

// ---- 3. browser tabs -----------------------------------------------------------------------------
const browser = await chromium.launch();
await openLendingTabs(browser, webOrigin, tabs, {
  onPageError: (i, err) => console.log(`  [tab ${i}] page error: ${String(err).slice(0, 120)}`),
});
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

// ---- 4. our own frame, with kill half in the middle ---------------------------------------------
// The machine may already be looping; launch the golden frame ourselves so the run is comparable
// whatever it was doing (a human launch goes ahead of automatic continuations, design §6.7).
// A deploy that changed the program seeds a second "mandelbrot" (a new bundle hash); the goldens
// belong to the newest one, so pick by name and the latest addedAt.
const bundle = [...(snapshot.programs ?? [])]
  .filter((p) => p.name === "mandelbrot")
  .sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0))[0]?.bundle as string;
const loopRunning =
  events.some((e) => e.t === "executionStarted") || (snapshot.execution ?? null) !== null;
record(
  "default loop",
  loopRunning ? "the machine was already rendering when we arrived" : "idle until our launch",
  null,
);
send({ t: "launch", bundle, params: golden.params, inherit: null });
const started = (await waitFor(
  (e) =>
    e.t === "executionStarted" &&
    (e as Ev & { execution: { human: boolean } }).execution.human === true,
  120_000,
  "our execution to start",
)) as Ev & { execution: { executionId: string; params: Record<string, unknown> } };
const executionId = started.execution.executionId;
const startedAtEvent = events.indexOf(started);
record(
  "launch accepted",
  `execution ${executionId} with params ${JSON.stringify(started.execution.params)}`,
  JSON.stringify(Object.entries(started.execution.params).sort()) ===
    JSON.stringify(Object.entries(golden.params).sort()),
);
/** Tiles settled by our execution: task ids first seen after it started. */
const ourTiles = (upTo = events.length): Map<string, string> => {
  const tiles = new Map<string, string>();
  for (const e of events.slice(startedAtEvent, upTo)) {
    if (e.t === "taskDone" && e.place !== null) tiles.set(e.taskId as string, e.output as string);
  }
  return tiles;
};
const killDeadline = Date.now() + timeoutS * 1000;
while (ourTiles().size < killAt && Date.now() < killDeadline) await sleep(250);
const beforeKill = ourTiles().size;
const leftBefore = events.filter((e) => e.t === "nodeLeft").length;
const reassignedBefore = events.filter((e) => e.t === "taskReassigned").length;
send({ t: "killHalf" });
const applied = (await waitFor(
  (e) => e.t === "controlApplied" && e.op === "killHalf",
  15_000,
  "killHalf applied",
)) as Ev & { nodeIds: string[] };
await sleep(6_000);
const left = events.filter((e) => e.t === "nodeLeft").length - leftBefore;
const reassigned = events.filter((e) => e.t === "taskReassigned").length - reassignedBefore;
record(
  "kill half",
  `${applied.nodeIds.length} victims at ${beforeKill} tiles; ${left} nodeLeft, ${reassigned} taskReassigned within 6 s`,
  applied.nodeIds.length >= Math.floor(joined / 2) && left >= applied.nodeIds.length,
);

const outcome = await waitFor(
  (e) => (e.t === "executionDone" || e.t === "executionFailed") && e.executionId === executionId,
  Math.max(30_000, killDeadline - Date.now()),
  "our execution to end",
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
  obs.close();
  await browser.close();
  process.exit(1);
}
const done = outcome as Ev & { followUp: Record<string, unknown> | null };
const tiles = ourTiles(events.indexOf(outcome));
// The frame repeats tiles (flat regions), so compare multisets, not sets.
const sorted = [...tiles.values()].sort();
const goldenSorted = [...golden.hashes].sort();
const matching = sorted.filter((h, i) => h === goldenSorted[i]).length;
const failed = events.filter((e) => e.t === "taskFailed").length;
record(
  "frame complete",
  `${tiles.size} tiles settled in ${elapsed()}, ${matching} of ${golden.taskCount} match the goldens tile for tile, ${failed} task failures, follow-up ${JSON.stringify(done.followUp)}`,
  tiles.size === golden.taskCount && matching === golden.taskCount && failed === 0,
);
const speculated = events.filter((e) => e.t === "taskSpeculated").length;
const verified = events.filter((e) => e.t === "taskVerified").length;
record(
  "scheduler activity",
  `${speculated} speculated, ${verified} verified, ${reassigned} reassigned after the kill`,
  null,
);
const hashes = new Set(tiles.values());

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
// The bucket holds a snapshot every five seconds for a day, so a plain listing pages; ask for the
// pointer and this generation's prefix directly.
const s3 = new S3Client({});
let latestSize = 0;
let ageS = Number.NaN;
try {
  const head = await s3.send(
    new HeadObjectCommand({ Bucket: snapshotBucket, Key: "latest.json.gz" }),
  );
  latestSize = head.ContentLength ?? 0;
  ageS = head.LastModified ? (Date.now() - head.LastModified.getTime()) / 1000 : Number.NaN;
} catch {
  /* missing */
}
const thisGen = await s3.send(
  new ListObjectsV2Command({ Bucket: snapshotBucket, Prefix: `g${on.generation}/`, MaxKeys: 5 }),
);
const genCount = thisGen.KeyCount ?? 0;
record(
  "S3 snapshots",
  `latest.json.gz ${latestSize ? `${latestSize} bytes, ${ageS.toFixed(0)} s old` : "missing"}; generation prefix g${on.generation}/ ${genCount ? "present" : "absent"}`,
  latestSize > 0 && ageS < 120 && genCount > 0,
);

// ---- 7. continuation while we watch ------------------------------------------------------------
try {
  const next = (await waitFor(
    (e) =>
      e.t === "executionStarted" &&
      (e as Ev & { execution: { executionId: string; human: boolean } }).execution.executionId !==
        executionId &&
      (e as Ev & { execution: { human: boolean } }).execution.human === false,
    60_000,
    "the machine to return to its default loop",
  )) as Ev & { execution: { params: Record<string, unknown>; human: boolean } };
  record(
    "back to the default loop",
    `next execution started with ${JSON.stringify(next.execution.params)}, human ${next.execution.human}`,
    next.execution.human === false,
  );
} catch (err) {
  record("back to the default loop", String(err), false);
}

obs.close();
await browser.close();
summary(t0);
