// The whole M1 pipeline on a laptop: the control-plane process seeds Mandelbrot, an observer
// watches, two local cores (the Node platform) compute, and the frame's 640 tiles hash to the
// goldens; then the default loop continues on its own (design §12).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { PROTOCOL_VERSION } from "@tabframe/protocol";
import { buildFixturePrograms, goldens, ROOT } from "./fixtures.ts";
import { spawnProcess } from "./testing.ts";

const MAIN = path.resolve(import.meta.dirname, "main.ts");
const NODE_MAIN = path.join(ROOT, "packages/node/src/platform/node.ts");
const children: ChildProcess[] = [];
let pub = "";
let priv = "";

async function startControlPlane(programsDir: string): Promise<void> {
  const started = await spawnProcess(
    MAIN,
    {
      TABFRAME_MODE: "local",
      TABFRAME_PUBLIC_PORT: "0",
      TABFRAME_PRIVATE_PORT: "0",
      TABFRAME_TICK_MS: "50",
      TABFRAME_PROGRAMS_DIR: programsDir,
      TABFRAME_SNAPSHOT_MS: "500",
    },
    '"listening"',
    { timeoutMs: 20_000, stderrPrefix: "[cp] " },
  );
  children.push(started.child);
  const info = started.line as { publicPort: number; privatePort: number; host: string };
  pub = `http://${info.host}:${info.publicPort}`;
  priv = `http://${info.host}:${info.privatePort}`;
}

async function startCore(name: string): Promise<void> {
  const started = await spawnProcess(
    NODE_MAIN,
    { TABFRAME_SESSION_URL: `${pub}/session`, TABFRAME_HOST_ID: name },
    '"status"',
    {
      stderrPrefix: `[${name}] `,
      // Surface what matters from the core's log: closes, refusals, task failures.
      onLine: (line) => {
        if (
          /"event":"(closed|bad-message|task-failed|assign-over-capacity|stray-presigned)"/.test(
            line,
          )
        )
          process.stderr.write(`[${name}] ${line}\n`);
      },
    },
  );
  children.push(started.child);
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
    // Seeding happens at boot; on a slow runner the first snapshot can arrive before it is done, in
    // which case the program is announced right after. Either way it is listed as mandelbrot:tiles.
    const snapshot = obs.events[0] as { programs?: Array<{ name: string; view: string }> };
    if (snapshot.programs?.length) {
      expect(snapshot.programs.map((p) => `${p.name}:${p.view}`)).toEqual(["mandelbrot:tiles"]);
    } else {
      await obs.waitFor(
        (e) => e.t === "programAdded" && (e as { name?: string }).name === "mandelbrot",
        20_000,
      );
    }
    await startCore("core-1");
    await startCore("core-2");
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
      programs: string[];
      nodes: number;
      snapshots: { writes: number; lastKey: string | null };
    };
    expect(health.programs).toEqual(["mandelbrot"]);
    expect(health.nodes).toBe(2);
    expect(health.snapshots.writes).toBeGreaterThan(0);
    expect(health.snapshots.lastKey?.startsWith("g1/")).toBe(true);
    const snap = (await (await fetch(`${priv}/snapshot`)).json()) as { executions: unknown[] };
    expect(snap.executions.length).toBeGreaterThanOrEqual(2);
    obs.ws.close();
  }, 180_000);
});
