// The whole M1 pipeline on a laptop: the control-plane process seeds Mandelbrot, an observer
// watches, two local cores (the Node platform) compute, and the frame's 640 tiles hash to the
// goldens; then the default loop continues on its own (design §12, plan WP1.7).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { PROTOCOL_VERSION } from "@tabframe/protocol";
import { buildFixturePrograms, goldens, ROOT } from "./fixtures.ts";

const MAIN = path.resolve(import.meta.dirname, "main.ts");
const NODE_MAIN = path.join(ROOT, "packages/node/src/platform/node.ts");
const children: ChildProcess[] = [];
let pub = "";
let priv = "";

function startControlPlane(programsDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [MAIN], {
      env: {
        ...process.env,
        TABFRAME_MODE: "local",
        TABFRAME_PUBLIC_PORT: "0",
        TABFRAME_PRIVATE_PORT: "0",
        TABFRAME_TICK_MS: "50",
        TABFRAME_PROGRAMS_DIR: programsDir,
        TABFRAME_SNAPSHOT_MS: "500",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let buf = "";
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.includes('"listening"')) continue;
        const info = JSON.parse(line) as { publicPort: number; privatePort: number; host: string };
        pub = `http://${info.host}:${info.publicPort}`;
        priv = `http://${info.host}:${info.privatePort}`;
        resolve();
      }
    });
    child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[cp] ${d.toString()}`));
    child.on("exit", (code) => {
      if (!pub) reject(new Error(`control plane exited early with ${code}`));
    });
    setTimeout(() => reject(new Error("control plane did not start")), 20_000);
  });
}

function startCore(name: string): void {
  const child = spawn("node", [NODE_MAIN], {
    env: { ...process.env, TABFRAME_SESSION_URL: `${pub}/session`, TABFRAME_HOST_ID: name },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[${name}] ${d.toString()}`));
  // Surface what matters from the core's log: closes, refusals, task failures.
  child.stdout?.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (
        /"event":"(closed|bad-message|task-failed|assign-over-capacity|stray-presigned)"/.test(line)
      )
        process.stderr.write(`[${name}] ${line}\n`);
    }
  });
}

type Ev = { t: string; [key: string]: unknown };

/** An observer that keeps pinging and collects every event. */
function observe(): Promise<{
  events: Ev[];
  ws: WebSocket;
  waitFor: (pred: (e: Ev) => boolean, ms: number) => Promise<Ev>;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${pub.replace("http", "ws")}/observer`);
    const events: Ev[] = [];
    const waiters: Array<{ pred: (e: Ev) => boolean; resolve: (e: Ev) => void }> = [];
    ws.onopen = () => ws.send(JSON.stringify({ t: "subscribe", v: PROTOCOL_VERSION, gen: 1 }));
    ws.onmessage = (m) => {
      const ev = JSON.parse(String(m.data)) as Ev;
      events.push(ev);
      for (const w of waiters.splice(0)) {
        if (w.pred(ev)) w.resolve(ev);
        else waiters.push(w);
      }
    };
    ws.onerror = (e) => reject(e);
    const ping = setInterval(() => {
      if (ws.readyState === ws.OPEN)
        ws.send(JSON.stringify({ t: "ping", v: PROTOCOL_VERSION, gen: 1 }));
    }, 1_000);
    ws.onclose = () => clearInterval(ping);
    const waitFor = (pred: (e: Ev) => boolean, ms: number) =>
      new Promise<Ev>((res, rej) => {
        const found = events.find(pred);
        if (found) return res(found);
        const timer = setTimeout(
          () =>
            rej(
              new Error(
                `timed out waiting for an event (${events.length} seen, last ${events.at(-1)?.t})`,
              ),
            ),
          ms,
        );
        waiters.push({
          pred,
          resolve: (e) => {
            clearTimeout(timer);
            res(e);
          },
        });
      });
    waitFor((e) => e.t === "snapshot", 10_000).then(() => resolve({ events, ws, waitFor }), reject);
  });
}

beforeAll(async () => {
  const dir = await buildFixturePrograms();
  await startControlPlane(dir);
}, 90_000);

afterAll(() => {
  for (const c of children) c.kill("SIGTERM");
});

describe("Mandelbrot end to end", () => {
  test("seeded program, default loop, 640 golden tiles, automatic continuation, snapshots", async () => {
    const golden = goldens();
    const obs = await observe();
    // Seeding happened at boot: the snapshot lists the program and the loop is queued once we watch.
    const snapshot = obs.events[0] as { programs?: Array<{ name: string; view: string }> };
    expect(snapshot.programs?.map((p) => `${p.name}:${p.view}`)).toEqual(["mandelbrot:tiles"]);
    startCore("core-1");
    startCore("core-2");
    await obs.waitFor((e) => e.t === "nodeJoined", 20_000);
    const started = (await obs.waitFor((e) => e.t === "executionStarted", 20_000)) as unknown as {
      execution: { executionId: string; params: Record<string, unknown> };
    };
    expect(started.execution.params).toEqual(golden.params);
    const first = started.execution.executionId;
    const done = (await obs.waitFor(
      (e) => e.t === "executionDone" && e.executionId === first,
      120_000,
    )) as unknown as { followUp: Record<string, unknown> | null; root: string | null };
    const tiles = obs.events.filter((e) => e.t === "taskDone" && e.place !== null);
    expect(tiles.length).toBe(golden.taskCount);
    expect(new Set(tiles.map((t) => t.output as string))).toEqual(new Set(golden.hashes));
    expect(done.followUp).toEqual({ preset: 1, palette: "ocean" });
    expect(done.root).not.toBeNull();
    expect(obs.events.some((e) => e.t === "taskFailed" || e.t === "executionFailed")).toBe(false);

    // D19: the default loop continues by itself while someone watches, inheriting the root.
    const next = (await obs.waitFor(
      (e) =>
        e.t === "executionStarted" &&
        (e as unknown as { execution: { executionId: string } }).execution.executionId !== first,
      30_000,
    )) as unknown as { execution: { params: Record<string, unknown>; human: boolean } };
    expect(next.execution.params).toEqual({ preset: 1, palette: "ocean" });
    expect(next.execution.human).toBe(false);

    // Snapshots were written while the ledger changed; health knows the counts.
    const health = (await (await fetch(`${priv}/health`)).json()) as {
      programs: number;
      nodes: number;
      snapshots: { writes: number; lastKey: string | null };
    };
    expect(health.programs).toBe(1);
    expect(health.nodes).toBe(2);
    expect(health.snapshots.writes).toBeGreaterThan(0);
    expect(health.snapshots.lastKey?.startsWith("g1/")).toBe(true);
    const snap = (await (await fetch(`${priv}/snapshot`)).json()) as { executions: unknown[] };
    expect(snap.executions.length).toBeGreaterThanOrEqual(2);
    obs.ws.close();
  }, 180_000);
});
