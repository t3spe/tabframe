// M0 verification runbook (design §9.6, plan WP0.11): retires the MicroVM unknowns against the real
// account. Launches a throwaway MicroVM from the deployed image with a short idle policy, exercises
// the endpoint through the real proxy, and prints one line per check. Account ids and tokens never
// reach stdout. Results are copied by hand into docs/m0-verification.md.
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { GetAccountSettingsCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import { GetServiceQuotaCommand, ServiceQuotasClient } from "@aws-sdk/client-service-quotas";
import { maskAccount } from "./mask.ts";

const region = process.env.AWS_REGION ?? "us-west-2";
const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : null;
const results: Array<{ check: string; result: string; pass: boolean | null }> = [];
function record(check: string, result: string, pass: boolean | null = null): void {
  results.push({ check, result, pass });
  console.log(`${pass === null ? "·" : pass ? "✓" : "✗"} ${check}: ${maskAccount(result)}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- outputs -------------------------------------------------------------------------------------
const cfn = new CloudFormationClient({ region });
async function outputs(stack: string): Promise<Record<string, string>> {
  const r = await cfn.send(new DescribeStacksCommand({ StackName: stack }));
  return Object.fromEntries(
    (r.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey ?? "", o.OutputValue ?? ""]),
  );
}
const image = await outputs("TabframeImage");
const core = await outputs("TabframeCore");
const imageArn = image.ImageArn ?? "";
const cpRoleArn = image.ControlPlaneRoleArn ?? "";
const storeBase = `${core.WebOrigin}/blob`;
if (!imageArn || !cpRoleArn) throw new Error("TabframeImage outputs missing; deploy first");

// ---- account facts ---------------------------------------------------------------------------------
const lambda = new LambdaClient({ region });
const acct = await lambda.send(new GetAccountSettingsCommand({}));
record(
  "Lambda concurrency",
  `${acct.AccountLimit?.ConcurrentExecutions} concurrent (jitter is the mechanism; increase requested)`,
  (acct.AccountLimit?.ConcurrentExecutions ?? 0) >= 10,
);
const quotas = new ServiceQuotasClient({ region });
try {
  const q = await quotas.send(
    new GetServiceQuotaCommand({ ServiceCode: "lambda", QuotaCode: "L-CD1C0CC4" }),
  );
  record("MicroVM memory quota", `${q.Quota?.Value} GB`, (q.Quota?.Value ?? 0) >= 8);
} catch (err) {
  record("MicroVM memory quota", `unreadable: ${String(err).slice(0, 80)}`, null);
}

// ---- throwaway MicroVM -----------------------------------------------------------------------------
const mv = new LambdaMicrovmsClient({ region });
const IDLE_SECONDS = 60;
const run = await mv.send(
  new RunMicrovmCommand({
    imageIdentifier: imageArn,
    executionRoleArn: cpRoleArn,
    ingressNetworkConnectors: [
      `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
    ],
    egressNetworkConnectors: [
      `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
    ],
    idlePolicy: {
      autoResumeEnabled: true,
      maxIdleDurationSeconds: IDLE_SECONDS,
      suspendedDurationSeconds: 900,
    },
    maximumDurationInSeconds: 1800,
    runHookPayload: JSON.stringify({
      role: "control-plane",
      generation: 999,
      snapshotKey: null,
      sessionUrl: null,
      storeBase,
      fleetSecret: "verify",
    }),
  }),
);
const id = run.microvmId ?? "";
let endpoint = run.endpoint ?? "";
console.log(`launched throwaway MicroVM (endpoint ${endpoint ? "assigned" : "pending"})`);
const t0 = Date.now();
for (;;) {
  const g = await mv.send(new GetMicrovmCommand({ microvmIdentifier: id }));
  endpoint = g.endpoint ?? endpoint;
  if (g.state === "RUNNING") break;
  if (g.state === "TERMINATED" || Date.now() - t0 > 240_000)
    throw new Error(`MicroVM did not reach RUNNING (${g.state})`);
  await sleep(2_000);
}
record("boot to RUNNING", `${Math.round((Date.now() - t0) / 1000)} s`, true);
const host = endpoint.replace(/^https?:\/\//, "").replace(/\/$/, "");
async function token(minutes: number, allPorts = true): Promise<string> {
  const r = await mv.send(
    new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: id,
      expirationInMinutes: minutes,
      allowedPorts: allPorts ? [{ allPorts: {} }] : [{ port: 8080 }],
    }),
  );
  return r.authToken?.["X-aws-proxy-auth"] ?? "";
}
const tok = await token(60);
const get = (path: string, port: number, t = tok) =>
  fetch(`https://${host}${path}`, {
    headers: { "X-aws-proxy-auth": t, "X-aws-proxy-port": String(port) },
  });
const protocols = (t: string, port = 8080) => [
  "lambda-microvms",
  `lambda-microvms.authentication.${t}`,
  `lambda-microvms.port.${port}`,
];
const hello = JSON.stringify({
  t: "hello",
  v: 1,
  gen: 999,
  hostId: "verify",
  kind: "core",
  cores: 1,
  sandboxVersion: "0",
});
const heartbeat = JSON.stringify({
  t: "heartbeat",
  v: 1,
  gen: 999,
  visible: true,
  queue: 0,
  lastTaskMs: null,
  tasksDone: 0,
});
function nodeSocket(t: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${host}/node`, protocols(t));
    ws.onopen = () => {
      ws.send(hello);
      resolve(ws);
    };
    ws.onerror = () => reject(new Error("socket error"));
  });
}

try {
  // health through the proxy: the run hook completed and the process is a control plane
  const h = (await (await get("/health", 8081)).json()) as { role?: string; generation?: number };
  record(
    "run hook → control plane",
    `role ${h.role}, generation ${h.generation}`,
    h.role === "control-plane",
  );

  if (!only || only === "diag") {
    const d = (await (await get("/diag", 8081)).json()) as { dns?: string; node?: string };
    record("DNS inside the image", `${d.dns} (node ${d.node})`, String(d.dns).startsWith("ok"));
  }

  if (!only || only === "idle") {
    // frames as idle traffic: heartbeat for > IDLE_SECONDS over one socket, then check state
    const ws = await nodeSocket(tok);
    let closedCode: number | null = null;
    ws.onclose = (e) => {
      closedCode = e.code;
    };
    const until = Date.now() + (IDLE_SECONDS + 45) * 1000;
    while (Date.now() < until && closedCode === null) {
      ws.send(heartbeat);
      await sleep(1_000);
    }
    const g = await mv.send(new GetMicrovmCommand({ microvmIdentifier: id }));
    record(
      "WebSocket frames count as idle-policy traffic",
      `state ${g.state} after ${IDLE_SECONDS + 45} s of frames only (socket ${closedCode === null ? "open" : `closed ${closedCode}`})`,
      g.state === "RUNNING" && closedCode === null,
    );
    ws.close();
  }

  if (!only || only === "token") {
    const short = await token(1);
    const ws = await nodeSocket(short);
    let closedCode: number | null = null;
    ws.onclose = (e) => {
      closedCode = e.code;
    };
    const until = Date.now() + 130_000;
    while (Date.now() < until && closedCode === null) {
      ws.send(heartbeat);
      await sleep(1_000);
    }
    record(
      "socket survives its token's expiry",
      closedCode === null ? "open after 130 s on a 1-minute token" : `closed ${closedCode}`,
      closedCode === null,
    );
    ws.close();
  }

  if (!only || only === "rate") {
    // request rate ramp against the private health route
    let firstThrottle: string | null = null;
    for (const rps of [10, 25, 50, 100, 200]) {
      let throttled = 0;
      const started = Date.now();
      while (Date.now() - started < 4_000) {
        const batch = Array.from({ length: rps / 5 }, () =>
          get("/health", 8081)
            .then((r) => r.status)
            .catch(() => 0),
        );
        const statuses = await Promise.all(batch);
        throttled += statuses.filter((s) => s === 429).length;
        await sleep(200);
      }
      if (throttled > 0) {
        firstThrottle = `${rps} req/s (${throttled} × 429)`;
        break;
      }
    }
    record(
      "endpoint request rate",
      firstThrottle ? `first throttling at ${firstThrottle}` : "no 429 up to 200 req/s",
      firstThrottle === null || Number.parseInt(firstThrottle, 10) >= 50,
    );
  }

  if (!only || only === "connections") {
    // Paced at 4 opens per second (the endpoint throttles bursts of HTTP requests, and an upgrade
    // is one), so a failure here is a concurrency limit rather than a rate limit.
    const sockets: WebSocket[] = [];
    let failures = 0;
    let firstFailureAt: number | null = null;
    for (let i = 0; i < 250; i++) {
      try {
        sockets.push(await nodeSocket(tok));
      } catch {
        failures++;
        if (firstFailureAt === null) firstFailureAt = i;
      }
      await sleep(250);
    }
    let closed = 0;
    for (const ws of sockets) ws.onclose = () => closed++;
    for (let s = 0; s < 20; s++) {
      for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.send(heartbeat);
      await sleep(1_000);
    }
    record(
      "concurrent WebSocket connections",
      `${sockets.length - closed} of 250 open after 20 s (${failures} failed to open${firstFailureAt === null ? "" : `, first failure at #${firstFailureAt + 1}`}, ${closed} closed)`,
      sockets.length - closed >= 250,
    );
    for (const ws of sockets) ws.close();
    await sleep(1_000);
  }

  if (!only || only === "msgrate") {
    const ws = await nodeSocket(tok);
    let closedCode: number | null = null;
    ws.onclose = (e) => {
      closedCode = e.code;
    };
    const until = Date.now() + 30_000;
    let sent = 0;
    while (Date.now() < until && closedCode === null) {
      ws.send(heartbeat);
      sent++;
      await sleep(66);
    }
    record(
      "per-connection message rate",
      `${Math.round(sent / 30)} msg/s for 30 s, socket ${closedCode === null ? "open" : `closed ${closedCode}`}`,
      closedCode === null,
    );
    ws.close();
  }

  if (!only || only === "mint") {
    let throttles = 0;
    const started = Date.now();
    await Promise.all(Array.from({ length: 20 }, () => token(5).catch(() => throttles++)));
    record(
      "token minting burst",
      `20 tokens in ${Date.now() - started} ms, ${throttles} throttled`,
      null,
    );
  }

  if (!only || only === "resume") {
    await mv.send(new SuspendMicrovmCommand({ microvmIdentifier: id }));
    for (let i = 0; i < 60; i++) {
      const g = await mv.send(new GetMicrovmCommand({ microvmIdentifier: id }));
      if (g.state === "SUSPENDED") break;
      await sleep(2_000);
    }
    // The proxy answers 502 while the MicroVM is being resumed behind it; the latency that matters
    // is until the first 200, so poll rather than judge the first answer.
    const t1 = Date.now();
    let status = 0;
    let answers = 0;
    while (Date.now() - t1 < 20_000) {
      const r = await get("/health", 8081);
      answers++;
      status = r.status;
      if (status === 200) break;
      await sleep(250);
    }
    record(
      "resume latency",
      `${Math.round((Date.now() - t1) / 100) / 10} s to the first 200 (${answers} requests, last status ${status})`,
      status === 200 && Date.now() - t1 < 5_000,
    );
  }
} finally {
  await mv.send(new TerminateMicrovmCommand({ microvmIdentifier: id }));
  console.log("throwaway MicroVM terminated");
}

console.log("\n| Check | Result | Pass |\n|---|---|---|");
for (const r of results)
  console.log(
    `| ${r.check} | ${maskAccount(r.result)} | ${r.pass === null ? "info" : r.pass ? "yes" : "no"} |`,
  );
