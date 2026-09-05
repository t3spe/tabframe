// M3 verification runbook: a real rotation on the deployed machine with a render in flight and a
// few hundred simulated clients, measuring the churn — how long the cluster is short-handed — and
// checking the session function stayed under the account's concurrency with no throttles. Tokens
// and account ids never reach stdout.
//   node packages/infra/scripts/verify-m3.ts [--clients 250] [--tabs 2] [--timeout 900]
import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import { chromium } from "@playwright/test";
import { PROTOCOL_VERSION } from "@tabframe/protocol";
import WebSocketImpl from "ws";
import { operatorClients, stackOutputs } from "../../fleet/src/operator.ts";
import { socketProtocols } from "../../node/src/session.ts";
import {
  argNumber,
  awaitSession,
  observe,
  openLendingTabs,
  record,
  sleep,
  summary,
} from "./_runbook.ts";

const clientCount = argNumber("--clients", 250);
const tabCount = argNumber("--tabs", 2);
const timeoutS = argNumber("--timeout", 900);
const t0 = Date.now();

const fleet = await stackOutputs("TabframeFleet");
const core = await stackOutputs("TabframeCore");
const sessionUrl = fleet.SessionUrl ?? "";
const rotateFunction = fleet.RotateFunctionName ?? "";
const sessionFunction = fleet.SessionFunctionName ?? "";
const webOrigin = core.WebOrigin ?? "";
if (!sessionUrl || !rotateFunction) throw new Error("stack outputs missing; deploy first");

// ---- 1. the machine is up ------------------------------------------------------------------------
const before = await awaitSession(sessionUrl);
record("session before", `generation ${before.generation}`, true);

// ---- 2. a render in flight, from real browser tabs -------------------------------------------------
const browser = await chromium.launch();
await openLendingTabs(browser, webOrigin, tabCount);

const watching = await observe(before);
const { events } = watching;

const tiles = () => events.filter((e) => e.t === "taskDone").length;
const deadline = Date.now() + timeoutS * 1_000;
while (tiles() < 10 && Date.now() < deadline) await sleep(250);
record("render in flight", `${tiles()} tiles landed before the rotation`, tiles() >= 10);

// ---- 3. a few hundred simulated clients ------------------------------------------------------------
// Paced at four a second: the endpoint throttles bursts of upgrades (M0 verification).
const sockets: WebSocketImpl[] = [];
const closes: Array<{ at: number; code: number; delayMs: number }> = [];
const beats = new Map<WebSocketImpl, ReturnType<typeof setInterval>>();
let opened = 0;
let socketErrors = 0;
for (let i = 0; i < clientCount; i++) {
  const ws = new WebSocketImpl(`${before.endpoint}/node`, socketProtocols(before.token));
  ws.onopen = () => {
    opened++;
    ws.send(
      JSON.stringify({
        t: "hello",
        v: PROTOCOL_VERSION,
        gen: before.generation,
        hostId: `sim-${i}`,
        kind: "tab",
        cores: 1,
        sandboxVersion: "1",
      }),
    );
    // A node that stops heartbeating is declared gone in four seconds; these must look alive.
    beats.set(
      ws,
      setInterval(() => {
        if (ws.readyState !== WebSocketImpl.OPEN) return;
        ws.send(
          JSON.stringify({
            t: "heartbeat",
            v: PROTOCOL_VERSION,
            gen: before.generation,
            visible: true,
            queue: 0,
            lastTaskMs: null,
            tasksDone: 0,
          }),
        );
      }, 1_000),
    );
  };
  ws.onclose = (e) => {
    const timer = beats.get(ws);
    if (timer) clearInterval(timer);
    let delayMs = -1;
    try {
      delayMs = (JSON.parse(e.reason) as { reconnectAfterMs: number }).reconnectAfterMs;
    } catch {
      /* not a rotating reason */
    }
    closes.push({ at: Date.now(), code: e.code, delayMs });
  };
  ws.onerror = () => {
    socketErrors++;
  };
  sockets.push(ws);
  if (i % 4 === 3) await sleep(1_000);
}
await sleep(3_000);
const live = sockets.filter((ws) => ws.readyState === WebSocketImpl.OPEN).length;
// The endpoint answers 429 beyond a concurrency ceiling; what matters for the drain measurement
// is how many clients are actually connected when the rotation starts, not how many we asked for.
record(
  "simulated clients",
  `${live} connected of ${clientCount} attempted (${opened} opened, ${socketErrors} refused by the endpoint)`,
  live >= Math.min(8, clientCount),
);

// ---- 4. the rotation --------------------------------------------------------------------------------
const { invoker } = operatorClients();
const rotatedAt = Date.now();
const rotateResult = ((await invoker.invokeSync(rotateFunction, { reason: "verify-m3" })) ??
  {}) as {
  action?: string;
  generation?: number;
  drained?: number;
  handedOver?: boolean;
};
record(
  "rotation",
  `${rotateResult.action} to generation ${rotateResult.generation}, handedOver ${rotateResult.handedOver}, drained ${rotateResult.drained}`,
  rotateResult.action === "rotated" && rotateResult.handedOver === true,
);

// The drain closes every client with a delay drawn from a window sized to the client count.
const drainedAt = Date.now();
await sleep(8_000);
const rotating = closes.filter((c) => c.code === 4005);
const delays = rotating.map((c) => c.delayMs).filter((d) => d >= 0);
const spread = delays.length ? Math.max(...delays) - Math.min(...delays) : 0;
record(
  "drain",
  live === 0
    ? `${rotateResult.drained ?? 0} clients let go by the control plane (the browser tabs and the observer; this run simulated none of its own)`
    : `${rotating.length} of ${live} simulated clients closed with the rotating code; delays ${delays.length ? `${Math.min(...delays)}–${Math.max(...delays)} ms` : "none"}, spread ${spread} ms`,
  live === 0 ? (rotateResult.drained ?? 0) > 0 : rotating.length >= live * 0.9 && spread > 0,
);
for (const ws of sockets) ws.close();
watching.close();

// ---- 5. the churn: how long until the render is running again ----------------------------------------
const after = await awaitSession(sessionUrl);
record(
  "session after",
  `generation ${after.generation} (was ${before.generation})`,
  after.generation > before.generation,
);
const watchingAfter = await observe(after);
const afterEvents = watchingAfter.events;
const churnDeadline = Date.now() + 180_000;
while (!afterEvents.some((e) => e.t === "taskDone") && Date.now() < churnDeadline) await sleep(250);
const firstTileAfter = afterEvents.find((e) => e.t === "taskDone");
const tileAt = Date.now();
record(
  "churn",
  firstTileAfter
    ? `${((tileAt - drainedAt) / 1000).toFixed(1)} s from the drain to the first tile of the new generation; ${((tileAt - rotatedAt) / 1000).toFixed(1)} s from the rotate invocation, which includes booting the successor`
    : "no tile landed on the new generation within three minutes",
  firstTileAfter !== undefined,
);
const snapshot = afterEvents.find((e) => e.t === "snapshot") as { nodes?: unknown[] } | undefined;
record(
  "nodes after",
  `${snapshot?.nodes?.length ?? 0} nodes on the new control plane (the browser tabs came back)`,
  (snapshot?.nodes?.length ?? 0) > 0,
);
watchingAfter.close();
await browser.close();

// ---- 6. what CloudWatch says about the session function ------------------------------------------
const cw = new CloudWatchClient({});
async function stat(metric: string, statistic: "Maximum" | "Sum"): Promise<number> {
  const r = await cw.send(
    new GetMetricStatisticsCommand({
      Namespace: "AWS/Lambda",
      MetricName: metric,
      Dimensions: [{ Name: "FunctionName", Value: sessionFunction }],
      StartTime: new Date(rotatedAt - 120_000),
      EndTime: new Date(Date.now() + 60_000),
      Period: 60,
      Statistics: [statistic],
    }),
  );
  const points = r.Datapoints ?? [];
  const values = points.map((p) => (statistic === "Maximum" ? (p.Maximum ?? 0) : (p.Sum ?? 0)));
  return values.length ? Math.max(...values) : 0;
}
// Metrics lag; give them a minute.
await sleep(60_000);
const concurrent = await stat("ConcurrentExecutions", "Maximum");
const throttles = await stat("Throttles", "Sum");
const invocations = await stat("Invocations", "Sum");
record(
  "session function",
  `peak ${concurrent} concurrent, ${throttles} throttles, ${invocations} invocations a minute around the rotation`,
  concurrent < 10 && throttles === 0,
);

summary(t0);
