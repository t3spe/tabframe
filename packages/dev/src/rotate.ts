// `mise run dev:rotate`: a real handover on a laptop (design §12). It starts a control plane,
// lets nodes and a browser attach, then runs the **real** rotate handler with a local driver: a
// MicroVM client that spawns control-plane processes instead of MicroVMs, and a control-plane
// client that talks to their private ports over plain HTTP. Everything else — the five steps, the
// pointer, the failure paths — is the code that runs on AWS.
//
// Flags: --cores N (default 2), --rotations N (default 1), --interval MS between rotations.
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { HttpControlPlaneClient } from "@tabframe/fleet/cp-client";
import { InMemoryPointerStore } from "@tabframe/fleet/pointer";
import { createRotateHandler, type RotateResult } from "@tabframe/fleet/rotate";
import type {
  MicrovmClient,
  MicrovmInfo,
  MicrovmState,
  PortSpec,
  RunMicrovmParams,
} from "@tabframe/fleet/types";
import { consoleLogger, realClock, realSleeper } from "@tabframe/fleet/types";

const root = path.resolve(import.meta.dirname, "../../..");
const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(name);
  const v = i > 0 ? Number(process.argv[i + 1]) : Number.NaN;
  return Number.isFinite(v) ? v : fallback;
};
const cores = arg("--cores", 2);
const rotations = arg("--rotations", 1);
const interval = arg("--interval", 8_000);

function say(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
}

interface LocalVm {
  info: MicrovmInfo;
  child: ChildProcess;
  publicPort: number;
  privatePort: number;
}

/**
 * A MicroVM client that runs control planes as local processes. `endpoint` is `127.0.0.1:<private
 * port>`, which is what the control-plane client dials; the proxy headers ride along and are
 * ignored by a plain HTTP server.
 */
class LocalMicrovms implements MicrovmClient {
  readonly vms = new Map<string, LocalVm>();
  private counter = 0;
  /** The public port of whichever control plane is active, for the session endpoint. */
  publicPortOf(microvmId: string): number {
    return this.vms.get(microvmId)?.publicPort ?? 0;
  }

  async run(params: RunMicrovmParams): Promise<MicrovmInfo> {
    const microvmId = `microvm-local-${++this.counter}`;
    const payload = JSON.parse(params.runHookPayload) as { generation: number };
    const child = spawn("node", [path.join(root, "packages/control-plane/src/main.ts")], {
      cwd: root,
      env: {
        ...process.env,
        TABFRAME_MODE: "local",
        TABFRAME_PUBLIC_PORT: "0",
        TABFRAME_PRIVATE_PORT: "0",
        TABFRAME_WEB_DIR: "packages/web/dist",
        TABFRAME_GENERATION: String(payload.generation),
        TABFRAME_TICK_MS: "200",
        TABFRAME_LOCAL_NEUTRAL: "1",
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const ports = await new Promise<{ publicPort: number; privatePort: number; host: string }>(
      (resolve, reject) => {
        let buf = "";
        child.stdout?.on("data", (d: Buffer) => {
          buf += d.toString();
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            process.stdout.write(`[${microvmId}] ${line}\n`);
            if (line.includes('"listening"')) resolve(JSON.parse(line));
          }
        });
        child.on("exit", (code) => reject(new Error(`control plane exited with ${code}`)));
        setTimeout(() => reject(new Error("control plane did not start")), 20_000);
      },
    );
    const info: MicrovmInfo = {
      microvmId,
      state: "RUNNING",
      endpoint: `127.0.0.1:${ports.privatePort}`,
      imageArn: params.imageArn,
      imageVersion: params.imageVersion,
      startedAt: new Date(),
      stateReason: null,
    };
    this.vms.set(microvmId, {
      info,
      child,
      publicPort: ports.publicPort,
      privatePort: ports.privatePort,
    });
    // The run hook is what turns a neutral process into a control plane, exactly as in the image.
    const res = await fetch(
      `http://127.0.0.1:${ports.privatePort}/aws/lambda-microvms/runtime/v1/run`,
      {
        method: "POST",
        body: JSON.stringify({ microvmId, runHookPayload: params.runHookPayload }),
      },
    );
    if (!res.ok) throw new Error(`/run answered ${res.status}`);
    return info;
  }

  async get(microvmId: string): Promise<MicrovmInfo | null> {
    return this.vms.get(microvmId)?.info ?? null;
  }
  async list(): Promise<MicrovmInfo[]> {
    return [...this.vms.values()].map((v) => v.info);
  }
  async terminate(microvmId: string): Promise<void> {
    const vm = this.vms.get(microvmId);
    if (!vm) return;
    vm.child.kill("SIGTERM");
    vm.info.state = "TERMINATED" as MicrovmState;
    this.vms.delete(microvmId);
  }
  async suspend(): Promise<void> {}
  async resume(): Promise<void> {}
  async createAuthToken(_id: string, _minutes: number, _ports: PortSpec[]): Promise<string> {
    return "local";
  }
}

// ---- the driver ------------------------------------------------------------------------------

const microvms = new LocalMicrovms();
const pointer = new InMemoryPointerStore({
  state: "on",
  microvmId: null,
  endpoint: null,
  generation: 0,
  imageVersion: null,
  updatedAt: "",
  pending: null,
});
/** Plain HTTP to a local private port; the proxy headers are harmless. */
const httpClient = (secret: string) =>
  new HttpControlPlaneClient({
    microvms,
    secret,
    fetchImpl: (url, init) =>
      fetch(url.replace(/^https:/, "http:"), init as RequestInit) as ReturnType<
        NonNullable<ConstructorParameters<typeof HttpControlPlaneClient>[0]["fetchImpl"]>
      >,
  });

const rotate = createRotateHandler({
  pointer,
  microvms,
  secrets: { read: async () => "local-secret" },
  clock: realClock,
  sleep: realSleeper,
  log: consoleLogger,
  config: {
    pointerParam: "local",
    region: "us-west-2",
    imageArn: "local",
    imageVersion: null,
    controlPlaneRoleArn: "local",
    sessionUrl: "http://127.0.0.1:0/session",
    // Empty: each control plane serves blobs from its own port, so it keeps its local store base.
    storeBase: "",
    fleetSecretArn: "local",
    readyTimeoutMs: 20_000,
    pollIntervalMs: 200,
  },
  controlPlane: httpClient,
  latestSnapshotKey: async () => null,
});

const children: ChildProcess[] = [];
function startCore(name: string, sessionUrl: string): void {
  const child = spawn("node", [path.join(root, "packages/node/src/platform/node.ts")], {
    cwd: root,
    env: { ...process.env, TABFRAME_SESSION_URL: sessionUrl, TABFRAME_HOST_ID: name },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  child.stdout?.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (/"event":"(closed|status)"/.test(line) && line.includes('"state":"connecting"')) {
        process.stdout.write(`[${name}] ${line}\n`);
      }
    }
  });
}

// A session endpoint of our own, so the nodes follow the pointer the way they follow the real one.
const SESSION_PORT = 4095;
const sessionServer = createServer((_req, res) => {
  void (async () => {
    const p = await pointer.read();
    const port = p.microvmId ? microvms.publicPortOf(p.microvmId) : 0;
    const body = port
      ? {
          endpoint: `ws://127.0.0.1:${port}`,
          token: "local",
          expiresAt: Date.now() + 30 * 60_000,
          storeBase: `http://127.0.0.1:${port}/blob`,
          generation: p.generation,
        }
      : { starting: true, retryAfterMs: 500 };
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  })();
});
await new Promise<void>((resolve) => sessionServer.listen(SESSION_PORT, "127.0.0.1", resolve));
const sessionUrl = `http://127.0.0.1:${SESSION_PORT}/`;

say("dev-rotate-start", { sessionUrl, cores, rotations, interval });
const first = await rotate();
say("rotate", first as unknown as Record<string, unknown>);
for (let i = 1; i <= cores; i++) startCore(`core-${i}`, sessionUrl);

for (let n = 1; n <= rotations; n++) {
  await new Promise((r) => setTimeout(r, interval));
  const before = await pointer.read();
  const result: RotateResult = await rotate();
  const after = await pointer.read();
  say("rotate", {
    ...(result as unknown as Record<string, unknown>),
    from: before.generation,
    to: after.generation,
  });
}

say("dev-rotate-done", { generation: (await pointer.read()).generation });
for (const child of children) child.kill("SIGTERM");
for (const vm of [...microvms.vms.keys()]) await microvms.terminate(vm);
sessionServer.close();
process.exit(0);
