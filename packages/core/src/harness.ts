// Test harness for the core: a ledger with a program, virtual time, and helpers that speak the
// wire the way nodes and observers do. Used by the unit tests and the churn simulation.
import { encodeStageSpec, PROTOCOL_VERSION, type StageSpec } from "@tabframe/protocol";
import { apply } from "./apply.ts";
import type { Effect, Event } from "./events.ts";
import { checkInvariants } from "./invariants.ts";
import { createLedger, type Ledger, type LedgerConfig } from "./ledger.ts";

export const H = (c: string) => c.repeat(64);
export const BUNDLE = H("b");
export const MODULE = H("d");

export interface Harness {
  ledger: Ledger;
  readonly now: number;
  advance(ms: number): void;
  connect(connId: string, role: "node" | "observer"): Effect[];
  send(connId: string, body: Record<string, unknown>): Effect[];
  raw(connId: string, raw: unknown): Effect[];
  disconnect(connId: string): Effect[];
  tick(): Effect[];
  event(e: Event): Effect[];
  hello(connId: string, hostId?: string, kind?: "tab" | "core"): Effect[];
  subscribe(connId: string): Effect[];
  heartbeat(connId: string, visible?: boolean): Effect[];
  addProgram(view?: "tiles" | "bars" | "text"): Effect[];
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
  assigns(effects: Effect[]): Array<{
    connId: string;
    taskId: string;
    attempt: number;
    kind: "run" | "plan";
    stage: number;
    index: number;
  }>;
  invariants(): string[];
  rng: () => number;
}

export function harness(config: Partial<LedgerConfig> = {}, gen = 3): Harness {
  const ledger = createLedger(gen, { storeBase: "https://cdn.test/blob", ...config }, 1_000_000);
  let now = 1_000_000;
  let seed = 12345;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x80000000;
  };
  const env = { v: PROTOCOL_VERSION, gen };
  const h: Harness = {
    ledger,
    get now() {
      return now;
    },
    rng,
    advance(ms) {
      now += ms;
    },
    event(e) {
      return apply(ledger, e, now, { rng });
    },
    connect: (connId, role) => apply(ledger, { kind: "connected", connId, role }, now, { rng }),
    send: (connId, body) =>
      apply(ledger, { kind: "message", connId, raw: JSON.stringify({ ...env, ...body }) }, now, {
        rng,
      }),
    raw: (connId, raw) => apply(ledger, { kind: "message", connId, raw }, now, { rng }),
    disconnect: (connId) => apply(ledger, { kind: "disconnected", connId }, now, { rng }),
    tick: () => apply(ledger, { kind: "tick" }, now, { rng }),
    hello(connId, hostId = "h1", kind = "tab") {
      h.connect(connId, "node");
      return h.send(connId, { t: "hello", hostId, kind, cores: 8, sandboxVersion: "1" });
    },
    subscribe(connId) {
      h.connect(connId, "observer");
      return h.send(connId, { t: "subscribe" });
    },
    heartbeat: (connId, visible = true) =>
      h.send(connId, { t: "heartbeat", visible, queue: 0, lastTaskMs: null, tasksDone: 0 }),
    addProgram: (view = "tiles") =>
      h.event({
        kind: "programAdded",
        bundle: BUNDLE,
        module: MODULE,
        manifest: { name: "demo", view, persist: false, defaultParams: { preset: 0 } },
      }),
    launch: (params = { preset: 0 }, human = true) =>
      h.event({ kind: "launch", bundle: BUNDLE, params, human, inherit: null }),
    planSpec(effects, spec) {
      const f = effects.find((e) => e.kind === "fetchBlob");
      if (!f || f.kind !== "fetchBlob") throw new Error("no fetchBlob effect");
      return h.event({
        kind: "blobFetched",
        hash: f.hash,
        bytes: encodeStageSpec(spec),
        purpose: f.purpose,
      });
    },
    manifestStored(effects, hash = H("f")) {
      const p = effects.find((e) => e.kind === "putBlob");
      if (!p || p.kind !== "putBlob") throw new Error("no putBlob effect");
      return h.event({ kind: "blobStored", hash, size: p.bytes.length, purpose: p.purpose });
    },
    result: (connId, taskId, attempt, output, extra = {}) =>
      h.send(connId, {
        t: "result",
        taskId,
        attempt,
        output,
        outputSize: 16,
        writes: [],
        log: null,
        computeMs: 100,
        ...extra,
      }),
    resultError: (connId, taskId, attempt, error) =>
      h.send(connId, { t: "result", taskId, attempt, error, computeMs: 5 }),
    assigns: (effects) =>
      effects
        .filter((e) => e.kind === "send" && e.msg.t === "assign")
        .map((e) => {
          if (e.kind !== "send" || e.msg.t !== "assign") throw new Error("unreachable");
          return {
            connId: e.connId,
            taskId: e.msg.taskId,
            attempt: e.msg.attempt,
            kind: e.msg.kind,
            stage: e.msg.stage,
            index: e.msg.index,
          };
        }),
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
