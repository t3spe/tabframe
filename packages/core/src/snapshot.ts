import { fromBase64, toBase64 } from "./bytes.ts";
import type { Effect } from "./events.ts";
import type {
  CoreRecord,
  ExecutionRecord,
  Ledger,
  NodeRecord,
  ProgramRecord,
  TaskRecord,
} from "./ledger.ts";
import { releaseNode } from "./scheduler.ts";

/**
 * The ledger as JSON for the S3 snapshot and the handover (design §9.4). Connections and observers
 * are not persisted: they belong to the process that held them. Nodes are, so an adopting
 * control plane knows what to release.
 */
export interface SerializedLedger {
  version: 1;
  meta: Ledger["meta"];
  config: Ledger["config"];
  nodes: NodeRecord[];
  programs: ProgramRecord[];
  /** Cloud cores travel with the ledger, so a successor inherits them (design §6.8). */
  cores?: CoreRecord[];
  executions: ExecutionRecord[];
  queue: string[];
  running: string | null;
  tasks: Array<Omit<TaskRecord, "input"> & { input: string }>;
}

export function serializeLedger(ledger: Ledger): string {
  const s: SerializedLedger = {
    version: 1,
    meta: ledger.meta,
    config: ledger.config,
    nodes: [...ledger.nodes.values()],
    programs: [...ledger.programs.values()],
    cores: [...ledger.cores.values()],
    executions: [...ledger.executions.values()],
    queue: ledger.queue,
    running: ledger.running,
    tasks: [...ledger.tasks.values()].map((t) => ({ ...t, input: toBase64(t.input) })),
  };
  return JSON.stringify(s);
}

export function deserializeLedger(json: string): Ledger {
  const s = JSON.parse(json) as SerializedLedger;
  if (s.version !== 1) throw new Error(`unsupported ledger version ${String(s.version)}`);
  return {
    // Fields added after a snapshot was written take their defaults.
    meta: {
      ...s.meta,
      phase: "active",
      lastObserverAt: s.meta.lastObserverAt ?? s.meta.startedAt,
      awake: s.meta.awake ?? true,
      sleepReason: s.meta.sleepReason ?? null,
      lastCoreLaunchAt: s.meta.lastCoreLaunchAt ?? 0,
      loopBackoffMs: s.meta.loopBackoffMs ?? 0,
      loopPausedUntil: s.meta.loopPausedUntil ?? 0,
    },
    config: s.config,
    conns: new Map(),
    nodes: new Map(s.nodes.map((n) => [n.nodeId, n])),
    nodeByConn: new Map(),
    observers: new Map(),
    // A snapshot written before bundles carried their files has none.
    programs: new Map(s.programs.map((p) => [p.bundle, { ...p, files: p.files ?? {} }])),
    cores: new Map((s.cores ?? []).map((c) => [c.microvmId, c])),
    executions: new Map(s.executions.map((e) => [e.executionId, e])),
    queue: s.queue,
    running: s.running,
    tasks: new Map(s.tasks.map((t) => [t.taskId, { ...t, input: fromBase64(t.input) }])),
  };
}

/**
 * Adopt a handed-over or restored ledger (design §9.4): every node is gone, so every open attempt
 * is released and the work returns to the front of the queue. Nothing is announced: there are no
 * observers yet.
 */
export function adoptLedger(ledger: Ledger, generation: number, now: number): Effect[] {
  const effects: Effect[] = [];
  for (const node of [...ledger.nodes.values()]) {
    effects.push(...releaseNode(ledger, node));
    ledger.nodes.delete(node.nodeId);
  }
  // The cores are still running out there; they will reconnect to this generation as new nodes,
  // and get the link timeout's grace from now, not from their launch (WP4.4: without this every
  // rotation terminated every core on its first tick).
  for (const core of ledger.cores.values()) {
    core.nodeId = null;
    core.unlinkedAt = now;
  }
  ledger.nodeByConn.clear();
  ledger.conns.clear();
  ledger.observers.clear();
  ledger.meta.generation = generation;
  ledger.meta.startedAt = now;
  // Whatever the source ledger was doing, this one is the active control plane now.
  ledger.meta.phase = "active";
  return effects;
}
