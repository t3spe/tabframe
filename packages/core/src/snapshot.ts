// The ledger as JSON for the S3 snapshot and the handover (design §9.4), and its adoption by a
// successor. The format stays at version 1: a field added later takes its default on the way in.
import { fromBase64, toBase64 } from "./bytes.ts";
import type { Effect } from "./events.ts";
import { pendingPurpose, resumePending } from "./execution.ts";
import {
  type CloudCoreRecord,
  type ExecutionRecord,
  freshSession,
  type Ledger,
  type Meta,
  type NodeRecord,
  type ProgramRecord,
  type TaskRecord,
} from "./ledger.ts";
import { releaseNode } from "./scheduler.ts";

/** The durable parts of a ledger. Connections and the session belong to the process that held them; nodes travel so an adopter knows what to release. */
export interface SerializedLedger {
  version: 1;
  meta: Meta;
  config: Ledger["config"];
  nodes: NodeRecord[];
  programs: ProgramRecord[];
  /** Cloud cores travel with the ledger, so a successor inherits them (design §6.8). */
  cores?: CloudCoreRecord[];
  executions: ExecutionRecord[];
  queue: string[];
  running: string | null;
  tasks: Array<Omit<TaskRecord, "input"> & { input: string }>;
}

/** An execution as older snapshots wrote it, before the ledger recorded what it was waiting for. */
type StoredExecution = Omit<ExecutionRecord, "awaiting"> & {
  awaiting?: ExecutionRecord["awaiting"];
  waitingSince?: number | null;
  storeErrors?: number;
};

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

/** Read a snapshot. Fields that older snapshots lack take their defaults; the session starts fresh. */
export function deserializeLedger(json: string): Ledger {
  const s = JSON.parse(json) as SerializedLedger;
  if (s.version !== 1) throw new Error(`unsupported ledger version ${String(s.version)}`);
  const m = s.meta;
  const legacyWaiting = new Map<string, { since: number; errors: number }>();
  const ledger: Ledger = {
    meta: {
      generation: m.generation,
      phase: "active",
      storeBase: m.storeBase,
      seq: m.seq,
      nodeCounter: m.nodeCounter,
      taskCounter: m.taskCounter,
      executionCounter: m.executionCounter,
      redundancy: m.redundancy,
      startedAt: m.startedAt,
      lastInteractionAt: m.lastInteractionAt,
      lastObserverAt: m.lastObserverAt ?? m.startedAt,
      awake: m.awake ?? true,
      sleepReason: m.sleepReason ?? null,
      lastCoreLaunchAt: m.lastCoreLaunchAt ?? 0,
      loopBackoffMs: m.loopBackoffMs ?? 0,
      loopPausedUntil: m.loopPausedUntil ?? 0,
      loopStopped: m.loopStopped ?? false,
      loopYielded: m.loopYielded ?? false,
      coreLaunches: m.coreLaunches ?? [],
    },
    config: s.config,
    session: freshSession(),
    conns: new Map(),
    nodeByConn: new Map(),
    observers: new Map(),
    nodes: new Map(
      s.nodes.map((n) => [
        n.nodeId,
        {
          ...n,
          heartbeatAt: n.heartbeatAt ?? null,
          announcedHealth: n.announcedHealth ?? null,
          healthAnnouncedAt: n.healthAnnouncedAt ?? null,
        },
      ]),
    ),
    programs: new Map(s.programs.map((p) => [p.bundle, { ...p, files: p.files ?? {} }])),
    // A core from before launch tokens gets one no hello can show, so it is replaced, never claimed.
    cores: new Map(
      (s.cores ?? []).map((c) => [
        c.microvmId,
        {
          ...c,
          token: c.token ?? "",
          unlinkedAt: c.unlinkedAt ?? (c.nodeId === null ? c.launchedAt : null),
        },
      ]),
    ),
    executions: new Map(
      (s.executions as StoredExecution[]).map(({ waitingSince, storeErrors, ...e }) => {
        if (e.awaiting === undefined && waitingSince != null)
          legacyWaiting.set(e.executionId, { since: waitingSince, errors: storeErrors ?? 0 });
        return [e.executionId, { ...e, awaiting: e.awaiting ?? null }];
      }),
    ),
    queue: s.queue,
    running: s.running,
    tasks: new Map(s.tasks.map((t) => [t.taskId, { ...t, input: fromBase64(t.input) }])),
  };
  // A snapshot from before `awaiting` said only that a store answer was pending; which one is read
  // off the execution's state, as the older control plane did on every retry.
  for (const [executionId, legacy] of legacyWaiting) {
    const exec = ledger.executions.get(executionId);
    if (!exec) continue;
    const purpose = pendingPurpose(ledger, exec);
    exec.awaiting = purpose ? { purpose, ...legacy } : null;
  }
  return ledger;
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
  // The cores are still running out there and reconnect to this generation as new nodes; their
  // link grace counts from now, not from their launch.
  for (const core of ledger.cores.values()) {
    core.nodeId = null;
    core.unlinkedAt = now;
  }
  ledger.nodeByConn.clear();
  ledger.conns.clear();
  ledger.observers.clear();
  ledger.session = freshSession(now);
  // The store effect the running execution was waiting on was issued by the predecessor and never
  // answered here; it is issued again (blobs are content-addressed, so a repeat is harmless).
  effects.push(...resumePending(ledger, now, true));
  ledger.meta.generation = generation;
  ledger.meta.startedAt = now;
  ledger.meta.phase = "active";
  return effects;
}
