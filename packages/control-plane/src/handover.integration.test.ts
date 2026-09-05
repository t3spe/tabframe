// A handover between two real control-plane processes with real nodes attached, driven by the
// real rotate handler through the local driver (design §9.4, §12). This is `mise run dev:rotate`
// as a test: what it proves is that the ledger, the clients, and the work survive a generation
// change on the same machine the deploy path uses on AWS.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { HttpControlPlaneClient } from "@tabframe/fleet/cp-client";
import { InMemoryPointerStore } from "@tabframe/fleet/pointer";
import { createRotateHandler } from "@tabframe/fleet/rotate";
import type { MicrovmClient, MicrovmInfo, PortSpec, RunMicrovmParams } from "@tabframe/fleet/types";
import { consoleLogger, realClock, realSleeper } from "@tabframe/fleet/types";
import { PROTOCOL_VERSION } from "@tabframe/protocol";
import { buildFixturePrograms } from "./fixtures.ts";
import { spawnProcess, until } from "./testing.ts";

const root = path.resolve(import.meta.dir, "../../..");
const children: ChildProcess[] = [];
let programsDir = "";
let sessionServer: Server;
let sessionUrl = "";

interface LocalVm {
  info: MicrovmInfo;
  child: ChildProcess;
  publicPort: number;
}

class LocalMicrovms implements MicrovmClient {
  readonly vms = new Map<string, LocalVm>();
  private counter = 0;
  publicPortOf(id: string): number {
    return this.vms.get(id)?.publicPort ?? 0;
  }
  async run(params: RunMicrovmParams): Promise<MicrovmInfo> {
    const microvmId = `microvm-local-${++this.counter}`;
    const started = await spawnProcess(
      path.join(root, "packages/control-plane/src/main.ts"),
      {
        TABFRAME_MODE: "local",
        TABFRAME_PUBLIC_PORT: "0",
        TABFRAME_PRIVATE_PORT: "0",
        TABFRAME_TICK_MS: "100",
        TABFRAME_LOCAL_NEUTRAL: "1",
        TABFRAME_PROGRAMS_DIR: programsDir,
      },
      '"listening"',
      {
        cwd: root,
        timeoutMs: 20_000,
        stderrPrefix: "[cp] ",
        onLine: (line) => {
          if (
            /"event":"(seed|task-failed|bad-message|role|fetch-failed|put-failed|presign-failed)"/.test(
              line,
            )
          ) {
            process.stderr.write(`[cp] ${line}\n`);
          }
        },
      },
    );
    const child = started.child;
    children.push(child);
    const ports = started.line as { publicPort: number; privatePort: number };
    const info: MicrovmInfo = {
      microvmId,
      state: "RUNNING",
      endpoint: `127.0.0.1:${ports.privatePort}`,
      imageArn: params.imageArn,
      imageVersion: null,
      startedAt: new Date(),
      stateReason: null,
    };
    this.vms.set(microvmId, { info, child, publicPort: ports.publicPort });
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
  async get(id: string): Promise<MicrovmInfo | null> {
    return this.vms.get(id)?.info ?? null;
  }
  async list(): Promise<MicrovmInfo[]> {
    return [...this.vms.values()].map((v) => v.info);
  }
  async terminate(id: string): Promise<void> {
    const vm = this.vms.get(id);
    if (!vm) return;
    vm.child.kill("SIGTERM");
    this.vms.delete(id);
  }
  async suspend(): Promise<void> {}
  async resume(): Promise<void> {}
  async createAuthToken(_id: string, _m: number, _p: PortSpec[]): Promise<string> {
    return "local";
  }
}

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

const rotate = createRotateHandler({
  pointer,
  microvms,
  secrets: { read: async () => "local-secret" },
  clock: realClock,
  sleep: realSleeper,
  log: { info: () => {}, warn: consoleLogger.warn, error: consoleLogger.error },
  config: {
    pointerParam: "local",
    region: "us-west-2",
    imageArn: "local",
    imageVersion: null,
    controlPlaneRoleArn: "local",
    sessionUrl: "http://127.0.0.1:4096/",
    // Empty: each control plane serves blobs from its own port, so it keeps its local store base.
    storeBase: "",
    fleetSecretArn: "local",
    readyTimeoutMs: 20_000,
    pollIntervalMs: 100,
  },
  controlPlane: (secret) =>
    new HttpControlPlaneClient({
      microvms,
      secret,
      fetchImpl: (url, init) =>
        fetch(url.replace(/^https:/, "http:"), init as RequestInit) as never,
    }),
  latestSnapshotKey: async () => null,
});

beforeAll(async () => {
  programsDir = await buildFixturePrograms();
  sessionServer = createServer((_req, res) => {
    void (async () => {
      const p = await pointer.read();
      const port = p.microvmId ? microvms.publicPortOf(p.microvmId) : 0;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          port
            ? {
                endpoint: `ws://127.0.0.1:${port}`,
                token: "local",
                expiresAt: Date.now() + 1_800_000,
                storeBase: `http://127.0.0.1:${port}/blob`,
                generation: p.generation,
              }
            : { starting: true, retryAfterMs: 200 },
        ),
      );
    })();
  });
  await new Promise<void>((r) => sessionServer.listen(4096, "127.0.0.1", r));
  sessionUrl = "http://127.0.0.1:4096/";
}, 90_000);

afterAll(() => {
  for (const c of children) c.kill("SIGTERM");
  sessionServer?.close();
});

async function startNode(name: string): Promise<ChildProcess> {
  const started = await spawnProcess(
    path.join(root, "packages/node/src/platform/node.ts"),
    { TABFRAME_SESSION_URL: sessionUrl, TABFRAME_HOST_ID: name },
    '"status"',
    { cwd: root },
  );
  children.push(started.child);
  return started.child;
}

/** Watch a control plane as an observer, keeping the subscription alive. */
async function observe(port: number, gen: number) {
  const events: Array<Record<string, unknown> & { t: string }> = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/observer`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: "subscribe", v: PROTOCOL_VERSION, gen }));
      resolve();
    };
    ws.onerror = () => reject(new Error("observer failed"));
  });
  ws.onmessage = (m) => events.push(JSON.parse(String(m.data)));
  const ping = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: "ping", v: PROTOCOL_VERSION, gen }));
  }, 1_000);
  return {
    events,
    close: () => {
      clearInterval(ping);
      ws.close();
    },
  };
}

describe("a handover between two processes", () => {
  test("the ledger, the programs, and the nodes survive a generation change", async () => {
    const first = await rotate();
    expect(first.action).toBe("launched");
    const oldId = (await pointer.read()).microvmId as string;
    const oldPort = microvms.publicPortOf(oldId);
    const oldObserver = await observe(oldPort, 1);

    await startNode("core-1");
    await startNode("core-2");
    await until(
      () => oldObserver.events.filter((e) => e.t === "nodeJoined").length >= 2,
      30_000,
      "two nodes to join the first control plane",
    );
    // The seeded program and the default loop are running by now.
    await until(
      () => oldObserver.events.some((e) => e.t === "executionStarted"),
      30_000,
      "the default loop to start",
    );
    // Rotate mid-render: wait until tiles are actually landing.
    await until(
      () => oldObserver.events.filter((e) => e.t === "taskDone").length >= 5,
      60_000,
      `tiles (last: ${JSON.stringify(oldObserver.events.filter((e) => e.t === "taskFailed" || e.t === "executionFailed").slice(-1))})`,
    );

    // ---- the rotation -------------------------------------------------------------------------
    const result = await rotate();
    expect(result).toMatchObject({
      action: "rotated",
      from: oldId,
      generation: 2,
      handedOver: true,
    });
    expect(result.action === "rotated" && result.drained).toBeGreaterThanOrEqual(3);
    oldObserver.close();

    const newId = (await pointer.read()).microvmId as string;
    expect(newId).not.toBe(oldId);
    const newPort = microvms.publicPortOf(newId);
    const health = (await (
      await fetch(
        `http://127.0.0.1:${microvms.vms.get(newId)?.info.endpoint?.split(":")[1]}/health`,
      )
    ).json()) as { generation: number; programs: string[] };
    expect(health.generation).toBe(2);
    expect(health.programs).toEqual(["mandelbrot"]); // adopted, not reseeded

    // ---- the nodes come back and the render carries on -----------------------------------------
    const newObserver = await observe(newPort, 2);
    // A node that rejoined before this observer subscribed is in the snapshot, not in an event.
    const nodesSeen = () => {
      const snap = newObserver.events.find((e) => e.t === "snapshot") as
        | { nodes?: unknown[] }
        | undefined;
      return (
        (snap?.nodes?.length ?? 0) + newObserver.events.filter((e) => e.t === "nodeJoined").length
      );
    };
    await until(() => nodesSeen() >= 2, 60_000, "the nodes to rejoin the new control plane");
    // Two minutes: a CI runner has twice needed more than one (the frame is real compute on a
    // shared box). A frame that finished before this observer subscribed shows as a snapshot whose
    // execution is done rather than as an event, and counts too.
    await until(
      () =>
        newObserver.events.some((e) => e.t === "taskDone") ||
        newObserver.events.some(
          (e) =>
            e.t === "snapshot" &&
            (e as { execution?: { status?: string } | null }).execution?.status === "done",
        ),
      120_000,
      "tiles to land on the new generation",
    );
    const snapshot = newObserver.events.find((e) => e.t === "snapshot") as
      | { execution: { executionId: string } | null; programs?: unknown[] }
      | undefined;
    expect(snapshot?.programs).toHaveLength(1);
    // The execution the first generation started is the one the second is finishing.
    expect(snapshot?.execution?.executionId).toBe("e1");
    newObserver.close();
  }, 180_000);
});
