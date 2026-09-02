// What a dashboard sees across a rotation: the first snapshot from the successor, as a browser
// would receive it (used to chase an "asleep" banner the demo saw after every rotation, WP4.4).
//   node packages/infra/scripts/rotation-probe.ts
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { PROTOCOL_VERSION } from "@tabframe/protocol";
import { fetchSession, socketProtocols } from "../../node/src/session.ts";
import { maskAccount } from "./mask.ts";

const region = process.env.AWS_REGION ?? "us-west-2";
const cfn = new CloudFormationClient({ region });
const r = await cfn.send(new DescribeStacksCommand({ StackName: "TabframeFleet" }));
const out = Object.fromEntries(
  (r.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey ?? "", o.OutputValue ?? ""]),
);
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function watch(label: string): Promise<{ generation: number; close: () => void }> {
  let s = await fetchSession(out.SessionUrl ?? "", (u) => fetch(u));
  while (s.kind !== "on") {
    if (s.kind === "off") throw new Error("off");
    await sleep(s.retryAfterMs);
    s = await fetchSession(out.SessionUrl ?? "", (u) => fetch(u));
  }
  const session = s;
  const ws = new WebSocket(`${session.endpoint}/observer`, socketProtocols(session.token));
  ws.onopen = () =>
    ws.send(JSON.stringify({ t: "subscribe", v: PROTOCOL_VERSION, gen: session.generation }));
  ws.onmessage = (m) => {
    const e = JSON.parse(String(m.data)) as Record<string, unknown>;
    if (e.t === "snapshot" && e.page === 0) {
      const mach = e.machine as Record<string, unknown>;
      console.log(
        `${stamp()} [${label}] gen ${session.generation} snapshot: awake ${mach.awake}, reason ${JSON.stringify(mach.reason)}, nodes ${(e.nodes as unknown[]).length}, execution ${(e.execution as { status?: string } | null)?.status ?? "none"}`,
      );
    } else if (e.t === "machineSleeping" || e.t === "controlPlaneRotating") {
      console.log(`${stamp()} [${label}] ${JSON.stringify(e)}`);
    }
  };
  ws.onclose = (ev) =>
    console.log(`${stamp()} [${label}] closed ${ev.code} ${maskAccount(ev.reason)}`);
  const ping = setInterval(() => {
    if (ws.readyState === ws.OPEN)
      ws.send(JSON.stringify({ t: "ping", v: PROTOCOL_VERSION, gen: session.generation }));
  }, 1500);
  return {
    generation: session.generation,
    close: () => {
      clearInterval(ping);
      ws.close();
    },
  };
}

const before = await watch("before");
await sleep(3000);
console.log(`${stamp()} invoking rotate`);
const lambda = new LambdaClient({ region });
const invoked = lambda.send(
  new InvokeCommand({
    FunctionName: out.RotateFunctionName ?? "tabframe-rotate",
    InvocationType: "RequestResponse",
    Payload: new TextEncoder().encode(JSON.stringify({ reason: "probe" })),
  }),
);
// Reconnect as a browser would once told to, and keep asking the session until it moves on.
await sleep(8000);
for (let i = 0; i < 12; i++) {
  const s = await fetchSession(out.SessionUrl ?? "", (u) => fetch(u));
  if (s.kind === "on" && s.generation > before.generation) break;
  await sleep(2500);
}
const after = await watch("after");
console.log(`${stamp()} watching generation ${after.generation}`);
await invoked;
await sleep(25000);
before.close();
after.close();
