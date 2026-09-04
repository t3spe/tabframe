// Test harness for the core: a ledger with a program, virtual time, and helpers that speak the
// wire the way nodes and observers do. Used by the unit tests and the churn simulation.
import type { FsManifest } from "@tabframe/protocol";
import { encodeStageSpec, PROTOCOL_VERSION, type StageSpec } from "@tabframe/protocol";
import { apply } from "./apply.ts";
import type { Effect, Event } from "./events.ts";
import { checkInvariants } from "./invariants.ts";
import { createLedger, type Ledger, type LedgerConfig } from "./ledger.ts";

export const H = (c: string) => c.repeat(64);
export const BUNDLE = H("b");
/** What a seeded bundle looks like: the module, the manifest, one input. */
export const defaultBundleFiles: FsManifest["files"] = {
  "/program.wasm": { hash: H("d"), size: 100 },
  "/manifest.json": { hash: H("c"), size: 50 },
  "/in/data.txt": { hash: H("a"), size: 10 },
};
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
  const ledger = createLedger(gen, { storeBase: "https://cdn.test/blob", ...config }, 1_000_000);
  let now = 1_000_000;
  let seed = 12345;
  const rng =
    random ??
    (() => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x80000000;
    });
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
      // A launch without a token gets one (WP8.3): the ledger links a core only on a token match.
      if (e.kind === "coreLaunched" && e.token === undefined) {
        const token = coreTokens.get(e.microvmId) ?? `tok-${e.microvmId}`.padEnd(32, "0"); // the schema wants 16+ chars
        coreTokens.set(e.microvmId, token);
        e = { ...e, token };
      }
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
      // A core's hello carries the token its launch was given (WP8.2; strict since WP8.3).
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
