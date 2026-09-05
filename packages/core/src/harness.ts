// Test harness for the core: a ledger with a program, virtual time, and helpers that speak the
// wire the way nodes and observers do. Used by the unit tests and the churn simulation.
import type { FsManifest } from "@tabframe/protocol";
import { encodeStageSpec, PROTOCOL_VERSION, type StageSpec } from "@tabframe/protocol";
import { apply } from "./apply.ts";
import type { Effect, Event } from "./events.ts";
import { checkInvariants } from "./invariants.ts";
import {
  createLedger,
  type ExecutionRecord,
  type Ledger,
  type LedgerConfig,
  type WriteRecord,
} from "./ledger.ts";
import { adoptLedger, deserializeLedger } from "./snapshot.ts";

export const H = (c: string) => c.repeat(64);
export const BUNDLE = H("b");
/** What a seeded bundle looks like: the module, the manifest, one input. */
export const defaultBundleFiles: FsManifest["files"] = {
  "/program.wasm": { hash: H("d"), size: 100 },
  "/manifest.json": { hash: H("c"), size: 50 },
  "/in/data.txt": { hash: H("a"), size: 10 },
};
export const MODULE = H("d");

/** An event as a test writes it: a core launch may leave the token to the harness. */
export type HarnessEvent =
  | Exclude<Event, { kind: "coreLaunched" }>
  | { kind: "coreLaunched"; microvmId: string; token?: string };

export interface AssignSummary {
  connId: string;
  taskId: string;
  attempt: number;
  kind: "run" | "plan";
  stage: number;
  index: number;
  deadlineMs: number;
}

export interface Harness {
  readonly ledger: Ledger;
  readonly now: number;
  /** The generation every message the harness sends carries; `adopt` moves it. */
  readonly gen: number;
  advance(ms: number): void;
  /** Take over a handed-over ledger as generation `generation`, the way a successor process does; the adoption's effects. */
  adopt(json: string, generation: number): Effect[];
  connect(connId: string, role: "node" | "observer"): Effect[];
  send(connId: string, body: Record<string, unknown>): Effect[];
  raw(connId: string, raw: unknown): Effect[];
  disconnect(connId: string): Effect[];
  tick(): Effect[];
  event(e: HarnessEvent): Effect[];
  hello(connId: string, hostId?: string, kind?: "tab" | "core"): Effect[];
  subscribe(connId: string): Effect[];
  heartbeat(connId: string, visible?: boolean): Effect[];
  addProgram(
    view?: "tiles" | "bars" | "text",
    persist?: boolean,
    files?: FsManifest["files"],
  ): Effect[];
  launch(params?: Record<string, unknown>, human?: boolean): Effect[];
  /** Answer a fetchBlob effect for a plan task with this stage spec. */
  planSpec(effects: Effect[], spec: StageSpec): Effect[];
  /** Answer a putBlob effect (the folded manifest) with a hash. */
  manifestStored(effects: Effect[], hash?: string): Effect[];
  result(
    connId: string,
    taskId: string,
    attempt: number,
    output: string,
    extra?: Record<string, unknown>,
  ): Effect[];
  resultError(connId: string, taskId: string, attempt: number, error: string): Effect[];
  /** All assign messages in a batch of effects. */
  assigns(effects: Effect[]): AssignSummary[];
  /** The running plan attempt of an execution: where its result must come from. */
  planAssign(executionId: string): {
    connId: string;
    taskId: string;
    attempt: number;
    kind: "run" | "plan";
  };
  /**
   * A program, observer "o1", nodes c1..cn on hosts h1..hn, and a person's launch whose plan task
   * (two with redundancy, which must agree) has reported: the spec fetch is pending in the effects.
   */
  plannedLaunch(nodes: number, opts?: { redundancy?: boolean }): Effect[];
  /** `plannedLaunch` answered with a rendered stage of `tasks` tiles; the run assignments are in the effects. */
  stage(nodes: number, tasks: number, opts?: { redundancy?: boolean }): Effect[];
  /**
   * Run the running execution to done: a rendered stage of `tasks` tiles, every result carrying
   * `writes`, its manifest stored as `root`, and a planner that says done with no follow-up.
   */
  completeFrame(root: string, opts?: { tasks?: number; writes?: WriteRecord[] }): ExecutionRecord;
  invariants(): string[];
  rng: () => number;
}

/**
 * A ledger at virtual time 1 000 000 with a fixed-seed random source; the simulation passes its
 * own seeded `random` so victim selection replays with the rest of the run.
 */
export function harness(
  config: Partial<LedgerConfig> = {},
  gen = 3,
  random?: () => number,
): Harness {
  const coreTokens = new Map<string, string>();
  let ledger = createLedger(gen, { storeBase: "https://cdn.test/blob", ...config }, 1_000_000);
  let now = 1_000_000;
  let generation = gen;
  let seed = 12345;
  const rng =
    random ??
    (() => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x80000000;
    });
  const running = (): ExecutionRecord => {
    const exec = ledger.running ? ledger.executions.get(ledger.running) : undefined;
    if (!exec) throw new Error("nothing running");
    return exec;
  };
  const h: Harness = {
    get ledger() {
      return ledger;
    },
    get now() {
      return now;
    },
    get gen() {
      return generation;
    },
    rng,
    advance(ms) {
      now += ms;
    },
    adopt(json, next) {
      ledger = deserializeLedger(json);
      generation = next;
      return adoptLedger(ledger, next, now);
    },
    event(e) {
      if (e.kind === "coreLaunched") {
        // The ledger links a core only on a token match; the schema wants sixteen characters.
        const token =
          e.token ?? coreTokens.get(e.microvmId) ?? `tok-${e.microvmId}`.padEnd(32, "0");
        coreTokens.set(e.microvmId, token);
        return apply(ledger, { ...e, token }, now, { rng });
      }
      return apply(ledger, e, now, { rng });
    },
    connect: (connId, role) => apply(ledger, { kind: "connected", connId, role }, now, { rng }),
    send: (connId, body) =>
      apply(
        ledger,
        {
          kind: "message",
          connId,
          raw: JSON.stringify({ v: PROTOCOL_VERSION, gen: generation, ...body }),
        },
        now,
        { rng },
      ),
    raw: (connId, raw) => apply(ledger, { kind: "message", connId, raw }, now, { rng }),
    disconnect: (connId) => apply(ledger, { kind: "disconnected", connId }, now, { rng }),
    tick: () => apply(ledger, { kind: "tick" }, now, { rng }),
    hello(connId, hostId = "h1", kind = "tab") {
      h.connect(connId, "node");
      const coreToken = kind === "core" ? coreTokens.get(hostId.replace(/^core-/, "")) : undefined;
      return h.send(connId, {
        t: "hello",
        hostId,
        kind,
        cores: 8,
        sandboxVersion: "1",
        ...(coreToken ? { coreToken } : {}),
      });
    },
    subscribe(connId) {
      h.connect(connId, "observer");
      return h.send(connId, { t: "subscribe" });
    },
    heartbeat: (connId, visible = true) =>
      h.send(connId, { t: "heartbeat", visible, queue: 0, lastTaskMs: null, tasksDone: 0 }),
    addProgram: (view = "tiles", persist = false, files = defaultBundleFiles) =>
      h.event({
        kind: "programAdded",
        bundle: BUNDLE,
        module: MODULE,
        manifest: { name: "demo", view, persist, defaultParams: { preset: 0 } },
        files,
      }),
    launch: (params = { preset: 0 }, human = true) =>
      h.event({ kind: "launch", bundle: BUNDLE, params, human, inherit: null }),
    planSpec(effects, spec) {
      const f = effects.find((e) => e.kind === "fetchBlob");
      if (f?.kind !== "fetchBlob") throw new Error("no fetchBlob effect");
      return h.event({
        kind: "blobFetched",
        hash: f.hash,
        bytes: encodeStageSpec(spec),
        purpose: f.purpose,
      });
    },
    manifestStored(effects, hash = H("f")) {
      const p = effects.find((e) => e.kind === "putBlob");
      if (p?.kind !== "putBlob") throw new Error("no putBlob effect");
      return h.event({ kind: "blobStored", hash, size: p.bytes.length, purpose: p.purpose });
    },
    result: (connId, taskId, attempt, output, extra = {}) =>
      h.send(connId, {
        t: "result",
        taskId,
        attempt,
        output,
        outputSize: 256, // 8×8 RGBA, what renderSpec places
        writes: [],
        log: null,
        computeMs: 100,
        ...extra,
      }),
    resultError: (connId, taskId, attempt, error) =>
      h.send(connId, { t: "result", taskId, attempt, error, computeMs: 5 }),
    assigns: (effects) =>
      effects.flatMap((e) =>
        e.kind === "send" && e.msg.t === "assign"
          ? [
              {
                connId: e.connId,
                taskId: e.msg.taskId,
                attempt: e.msg.attempt,
                kind: e.msg.kind,
                stage: e.msg.stage,
                index: e.msg.index,
                deadlineMs: e.msg.deadlineMs,
              },
            ]
          : [],
      ),
    planAssign(executionId) {
      const exec = ledger.executions.get(executionId);
      const task = exec?.planTaskId ? ledger.tasks.get(exec.planTaskId) : undefined;
      const attempt = task?.attempts.find((a) => a.outcome === "running");
      if (!task || !attempt) throw new Error(`no running plan attempt for ${executionId}`);
      const node = ledger.nodes.get(attempt.nodeId);
      if (!node) throw new Error(`no node ${attempt.nodeId}`);
      return {
        connId: node.connId,
        taskId: task.taskId,
        attempt: attempt.attempt,
        kind: task.kind,
      };
    },
    plannedLaunch(nodes, opts = {}) {
      h.addProgram();
      h.subscribe("o1");
      if (opts.redundancy) h.send("o1", { t: "setRedundancy", on: true });
      for (let i = 1; i <= nodes; i++) h.hello(`c${i}`, `h${i}`);
      const plan = h.assigns(h.launch());
      if (plan.length !== (opts.redundancy ? 2 : 1) || !plan.every((p) => p.kind === "plan"))
        throw new Error(`expected the plan task's assignments, got ${JSON.stringify(plan)}`);
      let planned: Effect[] = [];
      for (const p of plan)
        planned = [...planned, ...h.result(p.connId, p.taskId, p.attempt, H("a"))];
      return planned;
    },
    stage: (nodes, tasks, opts = {}) => h.planSpec(h.plannedLaunch(nodes, opts), renderSpec(tasks)),
    completeFrame(root, opts = {}) {
      const { tasks = 1, writes = [] } = opts;
      const exec = running();
      const plan = h.planAssign(exec.executionId);
      const stage = h.planSpec(
        h.result(plan.connId, plan.taskId, plan.attempt, H("e")),
        renderSpec(tasks),
      );
      let pending = h.assigns(stage).filter((a) => a.kind === "run");
      let last = stage;
      while (pending.length > 0) {
        const next: AssignSummary[] = [];
        for (const run of pending) {
          last = h.result(run.connId, run.taskId, run.attempt, H("1"), { writes });
          next.push(...h.assigns(last).filter((a) => a.kind === "run"));
        }
        pending = next.length > 0 ? next : h.assigns(h.tick()).filter((a) => a.kind === "run");
      }
      h.manifestStored(last, root);
      const again = h.planAssign(exec.executionId);
      h.planSpec(h.result(again.connId, again.taskId, again.attempt, H("d")), doneSpec(null));
      if (exec.status !== "done")
        throw new Error(`${exec.executionId} is ${exec.status}, not done`);
      return exec;
    },
    invariants: () => checkInvariants(ledger),
  };
  return h;
}

/** A one-stage spec with n tasks and 8×8 placements, then done with follow-up params. */
export function renderSpec(n: number, name = "render"): StageSpec {
  return {
    kind: "stage",
    name,
    canvas: { w: 64, h: 64 },
    tasks: Array.from({ length: n }, (_, i) => ({
      input: new Uint8Array([i]),
      place: { x: (i % 8) * 8, y: Math.floor(i / 8) * 8, w: 8, h: 8 },
    })),
  };
}

export const doneSpec = (next: Record<string, unknown> | null = { preset: 1 }): StageSpec => ({
  kind: "done",
  next,
});

export const eventsOf = (effects: Effect[], connId: string) =>
  effects
    .filter((e) => e.kind === "send" && e.connId === connId)
    .map((e) => (e.kind === "send" ? e.msg.t : ""));
