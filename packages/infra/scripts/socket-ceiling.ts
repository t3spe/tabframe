// Why does a MicroVM endpoint refuse WebSocket upgrades past a certain count? (WP4.5)
//
// The M0 runbook measured 250 sustained sockets against a freshly launched MicroVM; against the
// live control plane the same client stops at about sixteen with a 429, and while those sockets
// are open the fleet's own calls to the private port are refused too. This script isolates the
// variable: same client, same code, different target.
//
//   node packages/infra/scripts/socket-ceiling.ts --fresh          # a throwaway MicroVM
//   node packages/infra/scripts/socket-ceiling.ts --fresh --memory 4096
//   node packages/infra/scripts/socket-ceiling.ts --live           # the deployed control plane
//   node packages/infra/scripts/socket-ceiling.ts --live --tokens 3
//   node packages/infra/scripts/socket-ceiling.ts --live --procs 3 # three client processes
//
// It terminates every MicroVM it launches. Tokens and account ids never reach stdout.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { PROTOCOL_VERSION } from "@tabframe/protocol";
import WebSocketImpl from "ws";
import { fetchSession, socketProtocols } from "../../node/src/session.ts";
import { maskAccount } from "./mask.ts";

const region = process.env.AWS_REGION ?? "us-west-2";
const argv = process.argv;
const flag = (name: string) => argv.includes(name);
const num = (name: string, fallback: number) => {
  const i = argv.indexOf(name);
  const v = i > 0 ? Number(argv[i + 1]) : Number.NaN;
  return Number.isFinite(v) ? v : fallback;
};
const attempts = num("--attempts", 60);
const gapMs = num("--gap", 250);
const tokens = num("--tokens", 1);
const procs = num("--procs", 1);
const memory = num("--memory", 1024);
const hold = num("--hold", 5_000);

const mv = new LambdaMicrovmsClient({ region });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function outputs(stack: string): Promise<Record<string, string>> {
  const cfn = new CloudFormationClient({ region });
  const r = await cfn.send(new DescribeStacksCommand({ StackName: stack }));
  return Object.fromEntries(
    (r.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey ?? "", o.OutputValue ?? ""]),
  );
}

export interface Target {
  microvmId: string;
  endpoint: string;
  /** The control plane's generation: a message stamped with any other is refused. */
  generation: number;
  /** Mint an independent token for the public port. */
  token(): Promise<string>;
  close(): Promise<void>;
  note: string;
}

/** A throwaway MicroVM from the deployed image: fresh, idle, ours alone. */
async function freshTarget(memoryMiB: number): Promise<Target> {
  const image = await outputs("TabframeImage");
  const core = await outputs("TabframeCore");
  const run = await mv.send(
    new RunMicrovmCommand({
      imageIdentifier: image.ImageArn as string,
      executionRoleArn: image.ControlPlaneRoleArn as string,
      ingressNetworkConnectors: [
        `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
      ],
      egressNetworkConnectors: [
        `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
      ],
      idlePolicy: {
        autoResumeEnabled: true,
        maxIdleDurationSeconds: 300,
        suspendedDurationSeconds: 900,
      },
      maximumDurationInSeconds: 1800,
      resources: memoryMiB === 1024 ? undefined : { minimumMemoryInMiB: memoryMiB },
      runHookPayload: JSON.stringify({
        role: "control-plane",
        generation: 999,
        snapshotKey: null,
        sessionUrl: null,
        storeBase: `${core.WebOrigin}/blob`,
        fleetSecret: "ceiling",
      }),
    } as never),
  );
  const microvmId = (run as { microvmId?: string }).microvmId ?? "";
  let endpoint = (run as { endpoint?: string }).endpoint ?? "";
  for (let i = 0; i < 60; i++) {
    const g = (await mv.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }))) as {
      state?: string;
      endpoint?: string;
    };
    endpoint = g.endpoint ?? endpoint;
    if (g.state === "RUNNING") break;
    await sleep(1_000);
  }
  await sleep(2_000);
  return {
    microvmId,
    generation: 999,
    endpoint: `wss://${endpoint.replace(/^https?:\/\//, "").replace(/\/$/, "")}`,
    token: async () => {
      const t = await mv.send(
        new CreateMicrovmAuthTokenCommand({
          microvmIdentifier: microvmId,
          expirationInMinutes: 30,
          allowedPorts: [{ port: 8080 }],
        }),
      );
      return (t as { authToken?: Record<string, string> }).authToken?.["X-aws-proxy-auth"] ?? "";
    },
    close: async () => {
      await mv.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
    },
    note: `throwaway MicroVM, ${memoryMiB} MiB, nothing else connected`,
  };
}

/** The deployed control plane, through the session function, as a browser would reach it. */
async function liveTarget(): Promise<Target> {
  const fleet = await outputs("TabframeFleet");
  const s = await fetchSession(fleet.SessionUrl as string, (u) => fetch(u));
  if (s.kind !== "on") throw new Error(`the machine is ${s.kind}`);
  // The pointer names the MicroVM, so the operator can mint tokens of its own and ask whether the
  // ceiling belongs to the token or to the endpoint.
  const raw = (await new SSMClient({ region }).send(
    new GetParameterCommand({ Name: "/tabframe/pointer" }),
  )) as { Parameter?: { Value?: string } };
  const pointer = JSON.parse(raw.Parameter?.Value ?? "{}") as { microvmId?: string };
  const microvmId = pointer.microvmId ?? "";
  return {
    microvmId,
    generation: s.generation,
    endpoint: s.endpoint,
    token: async () => {
      if (flag("--session-token") || !microvmId) return s.token;
      const t = await mv.send(
        new CreateMicrovmAuthTokenCommand({
          microvmIdentifier: microvmId,
          expirationInMinutes: 30,
          allowedPorts: [{ port: 8080 }],
        }),
      );
      return (t as { authToken?: Record<string, string> }).authToken?.["X-aws-proxy-auth"] ?? "";
    },
    close: async () => {},
    note: `the live control plane at generation ${s.generation}`,
  };
}

export interface Measurement {
  opened: number;
  live: number;
  firstFailureAt: number | null;
  errors: string[];
}

/** Open sockets one at a time until `attempts` is exhausted; hold them and count what survived. */
async function measure(
  endpoint: string,
  tokenFor: (i: number) => string,
  generation: number,
): Promise<Measurement> {
  const sockets: WebSocketImpl[] = [];
  const errors: string[] = [];
  let opened = 0;
  let firstFailureAt: number | null = null;
  for (let i = 0; i < attempts; i++) {
    const ws = new WebSocketImpl(`${endpoint}/node`, socketProtocols(tokenFor(i)));
    sockets.push(ws);
    ws.on("open", () => {
      opened++;
      ws.send(
        JSON.stringify({
          t: "hello",
          v: PROTOCOL_VERSION,
          gen: generation,
          hostId: `ceiling-${process.pid}-${i}`,
          kind: "tab",
          cores: 1,
          sandboxVersion: "1",
        }),
      );
      setInterval(() => {
        if (ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              t: "heartbeat",
              v: PROTOCOL_VERSION,
              gen: generation,
              visible: true,
              queue: 0,
              lastTaskMs: null,
              tasksDone: 0,
            }),
          );
        }
      }, 1_000).unref();
    });
    ws.on("error", (err: Error) => {
      if (firstFailureAt === null) firstFailureAt = i;
      errors.push(err.message);
    });
    await sleep(gapMs);
  }
  await sleep(hold);
  const live = sockets.filter((w) => w.readyState === 1).length;
  for (const w of sockets) w.close();
  return { opened, live, firstFailureAt, errors: [...new Set(errors)].slice(0, 3) };
}

// ---- worker mode: one client process, told where to connect ----------------------------------------
if (flag("--worker")) {
  const endpoint = argv[argv.indexOf("--endpoint") + 1] as string;
  const token = argv[argv.indexOf("--token") + 1] as string;
  const m = await measure(endpoint, () => token, num("--generation", 0));
  process.stdout.write(`${JSON.stringify(m)}\n`);
  process.exit(0);
}

// ---- the experiment ---------------------------------------------------------------------------------
const target = flag("--fresh") ? await freshTarget(memory) : await liveTarget();
console.log(`target: ${maskAccount(target.note)}`);
try {
  const minted: string[] = [];
  for (let i = 0; i < tokens; i++) minted.push(await target.token());
  console.log(`tokens: ${minted.length}${minted.length > 1 ? " (independent)" : ""}`);

  if (procs > 1) {
    // Several client processes at once: does the ceiling belong to a process or to the endpoint?
    const self = fileURLToPath(import.meta.url);
    const results = await Promise.all(
      Array.from(
        { length: procs },
        (_, i) =>
          new Promise<Measurement>((resolve) => {
            const child = spawn(
              "node",
              [
                self,
                "--worker",
                "--endpoint",
                target.endpoint,
                "--token",
                minted[i % minted.length] as string,
                "--attempts",
                String(attempts),
                "--gap",
                String(gapMs),
                "--hold",
                String(hold),
                "--generation",
                String(target.generation),
              ],
              { stdio: ["ignore", "pipe", "inherit"] },
            );
            let out = "";
            child.stdout.on("data", (d: Buffer) => {
              out += d.toString();
            });
            child.on("exit", () =>
              resolve(
                JSON.parse(
                  out.trim() || '{"opened":0,"live":0,"firstFailureAt":null,"errors":[]}',
                ) as Measurement,
              ),
            );
          }),
      ),
    );
    const total = results.reduce((n, r) => n + r.live, 0);
    for (const [i, r] of results.entries()) {
      console.log(
        `  process ${i + 1}: ${r.live} live of ${attempts} attempted (first failure at #${r.firstFailureAt ?? "none"})`,
      );
    }
    console.log(
      `RESULT: ${total} sockets across ${procs} processes${results[0]?.errors.length ? ` · ${results[0].errors[0]}` : ""}`,
    );
  } else {
    const m = await measure(
      target.endpoint,
      (i) => minted[i % minted.length] as string,
      target.generation,
    );
    console.log(
      `RESULT: ${m.live} live of ${attempts} attempted, ${m.opened} ever opened, first failure at #${m.firstFailureAt ?? "none"}${m.errors.length ? ` · ${m.errors.join(" | ")}` : ""}`,
    );
  }
} finally {
  await target.close();
}
process.exit(0);
