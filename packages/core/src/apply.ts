import {
  CLOSE,
  type Control,
  type ControlPlaneToObserver,
  decode,
  type Heartbeat,
  type Hello,
  LIMITS,
  type MachineView,
  nodeToControlPlane,
  observerToControlPlane,
  PROTOCOL_VERSION,
  type ProgramView,
  type Snapshot,
} from "@tabframe/protocol";
import type { Effect, Event } from "./events.ts";
import {
  addProgram,
  afterTaskSettled,
  cancelExecution,
  commandHalf,
  enqueue,
  ensureDefaultLoop,
  executionTasks,
  maybeStart,
  onInheritRoot,
  onManifestStored,
  onStageSpec,
  pruneExecutions,
  resumeAll,
} from "./executions.ts";
import {
  type ConnRole,
  executionView,
  type Ledger,
  type NodeRecord,
  nodeView,
  type ProgramRecord,
  queueEntry,
  taskView,
} from "./ledger.ts";
import { broadcast } from "./observers.ts";
import { onResult } from "./results.ts";
import { fill, relabelHealth, releaseNode } from "./scheduler.ts";

/** Connections that never say hello or subscribe are dropped after this long. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Observers that stop pinging are dropped after this long. */
const OBSERVER_SILENCE_MS = 5 * LIMITS.observerPingMs;

export interface ApplyOptions {
  /** Uniform random in [0, 1); victim selection for the demo controls. */
  rng?: () => number;
}

/**
 * The control plane as a function: one inbound event, the ledger updated in place, and the
 * effects the process must carry out. No I/O happens here; time is a parameter.
 */
export function apply(
  ledger: Ledger,
  event: Event,
  now: number,
  opts: ApplyOptions = {},
): Effect[] {
  const rng = opts.rng ?? Math.random;
  switch (event.kind) {
    case "connected":
      return onConnected(ledger, event.connId, event.role, now);
    case "message":
      return onMessage(ledger, event.connId, event.raw, now, rng);
    case "disconnected":
      return removeConnection(ledger, event.connId, "closed");
    case "tick":
      return tick(ledger, now);
    case "bundleRejected":
      return ledger.conns.has(event.connId)
        ? [
            {
              kind: "send",
              connId: event.connId,
              msg: errorMsg(ledger, "launch-refused", event.reason),
            },
          ]
        : [];
    case "programAdded":
      return [
        ...addProgram(ledger, event.bundle, event.module, event.manifest, event.files ?? {}, now),
        ...ensureDefaultLoop(ledger, now),
      ];
    case "launch": {
      const r = enqueue(
        ledger,
        { bundle: event.bundle, params: event.params, human: event.human, inherit: event.inherit },
        now,
      );
      if (r.error && event.connId) {
        return [
          { kind: "send", connId: event.connId, msg: errorMsg(ledger, "launch-refused", r.error) },
        ];
      }
      return [...r.effects, ...fill(ledger, now)];
    }
    case "blobFetched":
      if (event.purpose.type === "stageSpec")
        return onStageSpec(
          ledger,
          event.purpose.executionId,
          event.purpose.taskId,
          event.bytes,
          now,
        );
      if (event.purpose.type === "inheritRoot")
        return onInheritRoot(ledger, event.purpose.executionId, event.bytes, now);
      return [];
    case "blobStored":
      if (event.purpose.type === "manifest")
        return onManifestStored(
          ledger,
          event.purpose.executionId,
          event.purpose.stage,
          event.hash,
          now,
        );
      return [];
  }
}

function tick(ledger: Ledger, now: number): Effect[] {
  const effects = sweep(ledger, now);
  pruneExecutions(ledger);
  effects.push(...relabelHealth(ledger));
  effects.push(...ensureDefaultLoop(ledger, now));
  effects.push(...fill(ledger, now));
  return effects;
}

function onConnected(ledger: Ledger, connId: string, role: ConnRole, now: number): Effect[] {
  if (ledger.conns.has(connId)) return [];
  const rate = role === "node" ? LIMITS.nodeMessagesPerSecond : LIMITS.observerMessagesPerSecond;
  ledger.conns.set(connId, {
    connId,
    role,
    openedAt: now,
    bucket: { tokens: rate, refilledAt: now },
  });
  return [];
}

function onMessage(
  ledger: Ledger,
  connId: string,
  raw: unknown,
  now: number,
  rng: () => number,
): Effect[] {
  const conn = ledger.conns.get(connId);
  if (!conn) return [];

  const rate =
    conn.role === "node" ? LIMITS.nodeMessagesPerSecond : LIMITS.observerMessagesPerSecond;
  const b = conn.bucket;
  b.tokens = Math.min(rate, b.tokens + ((now - b.refilledAt) / 1000) * rate);
  b.refilledAt = now;
  if (b.tokens < 1) return refuse(ledger, connId, CLOSE.rateLimited, "message rate exceeded");
  b.tokens -= 1;

  const opts = { expectGen: ledger.meta.generation };
  if (conn.role === "node") {
    const d = decode(nodeToControlPlane, raw, opts);
    if (!d.ok) return refuse(ledger, connId, d.closeCode, d.reason);
    switch (d.msg.t) {
      case "hello":
        return onHello(ledger, connId, d.msg, now);
      case "heartbeat":
        return onHeartbeat(ledger, connId, d.msg, now);
      case "result": {
        const node = nodeOf(ledger, connId);
        if (!node) return refuse(ledger, connId, CLOSE.invalidMessage, "result before hello");
        node.lastSeen = now;
        const { effects, settlement } = onResult(ledger, node, d.msg, now);
        if (settlement.kind === "done" || settlement.kind === "failed")
          effects.push(...afterTaskSettled(ledger, settlement.task, now));
        effects.push(...fill(ledger, now));
        return effects;
      }
      case "presign": {
        const node = nodeOf(ledger, connId);
        if (!node) return refuse(ledger, connId, CLOSE.invalidMessage, "presign before hello");
        node.lastSeen = now;
        return [{ kind: "presign", connId, items: d.msg.items }];
      }
    }
  }
  const d = decode(observerToControlPlane, raw, opts);
  if (!d.ok) return refuse(ledger, connId, d.closeCode, d.reason);
  switch (d.msg.t) {
    case "subscribe":
      return onSubscribe(ledger, connId, now);
    case "ping":
      return onPing(ledger, connId, now);
    case "presign":
      if (!ledger.observers.has(connId))
        return refuse(ledger, connId, CLOSE.invalidMessage, "presign before subscribe");
      return [{ kind: "presign", connId, items: d.msg.items }];
    default:
      if (!ledger.observers.has(connId))
        return refuse(ledger, connId, CLOSE.invalidMessage, "control before subscribe");
      ledger.meta.lastInteractionAt = now;
      return onControl(ledger, connId, d.msg, now, rng);
  }
}

function onControl(
  ledger: Ledger,
  connId: string,
  msg: Control,
  now: number,
  rng: () => number,
): Effect[] {
  const running = ledger.running ? ledger.executions.get(ledger.running) : undefined;
  switch (msg.t) {
    case "killHalf":
    case "freezeHalf":
    case "throttleHalf": {
      const op = msg.t === "killHalf" ? "close" : msg.t === "freezeHalf" ? "freeze" : "throttle";
      const { effects, victims } = commandHalf(ledger, op, rng);
      effects.push(...broadcast(ledger, { t: "controlApplied", op: msg.t, nodeIds: victims }));
      return effects;
    }
    case "resumeAll": {
      const { effects, victims } = resumeAll(ledger);
      effects.push(
        ...broadcast(ledger, { t: "controlApplied", op: "resumeAll", nodeIds: victims }),
      );
      return effects;
    }
    case "restart": {
      if (!running) return [];
      const effects = cancelExecution(ledger, running, "restarted", now);
      effects.push(...broadcast(ledger, { t: "controlApplied", op: "restart", nodeIds: [] }));
      const relaunch = enqueue(
        ledger,
        {
          bundle: running.bundle,
          params: running.params,
          human: running.human,
          inherit: running.inheritedFrom,
        },
        now,
      );
      // A relaunch goes first whatever the queue holds.
      if (relaunch.executionId && ledger.queue.includes(relaunch.executionId)) {
        ledger.queue = [
          relaunch.executionId,
          ...ledger.queue.filter((id) => id !== relaunch.executionId),
        ];
      }
      effects.push(...relaunch.effects, ...maybeStart(ledger, now), ...fill(ledger, now));
      return effects;
    }
    case "skip": {
      if (!running) return [];
      const effects = cancelExecution(ledger, running, "skipped", now);
      effects.push(...broadcast(ledger, { t: "controlApplied", op: "skip", nodeIds: [] }));
      effects.push(
        ...ensureDefaultLoop(ledger, now),
        ...maybeStart(ledger, now),
        ...fill(ledger, now),
      );
      return effects;
    }
    case "killExecution": {
      const target = ledger.executions.get(msg.executionId);
      if (!target)
        return [
          { kind: "send", connId, msg: errorMsg(ledger, "unknown-execution", msg.executionId) },
        ];
      const effects = cancelExecution(ledger, target, "cancelled by an operator", now);
      effects.push(...broadcast(ledger, { t: "controlApplied", op: "killExecution", nodeIds: [] }));
      effects.push(
        ...ensureDefaultLoop(ledger, now),
        ...maybeStart(ledger, now),
        ...fill(ledger, now),
      );
      return effects;
    }
    case "launch": {
      const limited = launchRateExceeded(ledger, connId, now);
      if (limited)
        return [{ kind: "send", connId, msg: errorMsg(ledger, "rate-limited", limited) }];
      if (!ledger.programs.has(msg.bundle)) {
        // An uploaded bundle: the process fetches and validates it, then launches (design §5.2).
        return [
          {
            kind: "resolveBundle",
            bundle: msg.bundle,
            connId,
            params: msg.params,
            inherit: msg.inherit,
          },
        ];
      }
      const r = enqueue(
        ledger,
        { bundle: msg.bundle, params: msg.params, human: true, inherit: msg.inherit },
        now,
      );
      if (r.error)
        return [{ kind: "send", connId, msg: errorMsg(ledger, "launch-refused", r.error) }];
      return [...r.effects, ...fill(ledger, now)];
    }
    case "runFollowUp": {
      const limited = launchRateExceeded(ledger, connId, now);
      if (limited)
        return [{ kind: "send", connId, msg: errorMsg(ledger, "rate-limited", limited) }];
      const done = ledger.executions.get(msg.executionId);
      if (!done || done.status !== "done" || !done.followUp)
        return [{ kind: "send", connId, msg: errorMsg(ledger, "no-follow-up", msg.executionId) }];
      const r = enqueue(
        ledger,
        { bundle: done.bundle, params: done.followUp, human: true, inherit: done.executionId },
        now,
      );
      if (r.error)
        return [{ kind: "send", connId, msg: errorMsg(ledger, "launch-refused", r.error) }];
      return [...r.effects, ...fill(ledger, now)];
    }
    case "setRedundancy": {
      ledger.meta.redundancy = msg.on;
      return broadcast(ledger, { t: "controlApplied", op: "setRedundancy", nodeIds: [] });
    }
  }
}

function errorMsg(ledger: Ledger, code: string, message: string): ControlPlaneToObserver {
  return { t: "error", v: PROTOCOL_VERSION, gen: ledger.meta.generation, code, message };
}

function onHello(ledger: Ledger, connId: string, msg: Hello, now: number): Effect[] {
  if (ledger.nodeByConn.has(connId))
    return refuse(ledger, connId, CLOSE.invalidMessage, "duplicate hello");
  if (ledger.nodes.size >= LIMITS.nodeCap)
    return refuse(ledger, connId, CLOSE.nodeCap, "node cap reached");

  const nodeId = `n${++ledger.meta.nodeCounter}`;
  const node: NodeRecord = {
    nodeId,
    connId,
    hostId: msg.hostId,
    kind: msg.kind,
    cores: msg.cores,
    sandboxVersion: msg.sandboxVersion,
    joinedAt: now,
    lastSeen: now,
    visible: true,
    health: "fast",
    tasksDone: 0,
    lastTaskMs: null,
    ewmaMs: null,
    inFlight: [],
    commanded: null,
  };
  ledger.nodes.set(nodeId, node);
  ledger.nodeByConn.set(connId, nodeId);

  const effects: Effect[] = [
    {
      kind: "send",
      connId,
      msg: {
        t: "welcome",
        v: PROTOCOL_VERSION,
        gen: ledger.meta.generation,
        nodeId,
        heartbeatMs: LIMITS.heartbeatMs,
        maxInFlight: LIMITS.maxInFlight,
        storeBase: ledger.meta.storeBase,
      },
    },
  ];
  effects.push(...broadcast(ledger, { t: "nodeJoined", node: nodeView(node) }));
  effects.push(...fill(ledger, now));
  return effects;
}

function onHeartbeat(ledger: Ledger, connId: string, msg: Heartbeat, now: number): Effect[] {
  const node = nodeOf(ledger, connId);
  if (!node) return refuse(ledger, connId, CLOSE.invalidMessage, "heartbeat before hello");
  node.lastSeen = now;
  node.visible = msg.visible;
  // Throttled is the one label the node's own evidence decides: its host tab is hidden.
  if (!msg.visible && node.health !== "throttled") {
    node.health = "throttled";
    return broadcast(ledger, { t: "nodeHealth", nodeId: node.nodeId, health: node.health });
  }
  if (msg.visible && node.health === "throttled") {
    node.health = "fast";
    return broadcast(ledger, { t: "nodeHealth", nodeId: node.nodeId, health: node.health });
  }
  return [];
}

function onSubscribe(ledger: Ledger, connId: string, now: number): Effect[] {
  if (ledger.observers.has(connId))
    return refuse(ledger, connId, CLOSE.invalidMessage, "duplicate subscribe");
  if (ledger.observers.size >= LIMITS.observerCap)
    return refuse(ledger, connId, CLOSE.observerCap, "observer cap reached");
  ledger.observers.set(connId, { connId, subscribedAt: now, lastSeen: now, launchedAt: [] });
  ledger.meta.lastInteractionAt = now;
  const effects = snapshotPages(ledger, connId, now);
  effects.push(...ensureDefaultLoop(ledger, now));
  effects.push(...fill(ledger, now));
  return effects;
}

/** Page 0 carries the cluster; every page carries task rows (design §8.3). */
export function programView(p: ProgramRecord): ProgramView {
  return {
    bundle: p.bundle,
    name: p.manifest.name,
    view: p.manifest.view,
    description: p.manifest.description ?? null,
    defaultParams: p.manifest.defaultParams,
    addedAt: p.addedAt,
  };
}

export function snapshotPages(ledger: Ledger, connId: string, now: number): Effect[] {
  const exec = ledger.running ? ledger.executions.get(ledger.running) : undefined;
  const tasks = exec ? executionTasks(ledger, exec.executionId).map(taskView) : [];
  const pageSize = LIMITS.snapshotPageTasks;
  const pages = Math.max(1, Math.ceil(tasks.length / pageSize));
  const machine: MachineView = {
    awake: true,
    reason: null,
    redundancy: ledger.meta.redundancy,
    nextRotationAt: null,
    uptimeMs: Math.max(0, now - ledger.meta.startedAt),
  };
  const effects: Effect[] = [];
  for (let page = 0; page < pages; page++) {
    const slice = tasks.slice(page * pageSize, (page + 1) * pageSize);
    const base: Snapshot = {
      t: "snapshot",
      v: PROTOCOL_VERSION,
      gen: ledger.meta.generation,
      seq: ledger.meta.seq,
      page,
      pages,
      tasks: slice,
      at: now,
    };
    effects.push({
      kind: "send",
      connId,
      msg:
        page === 0
          ? {
              ...base,
              nodes: [...ledger.nodes.values()].map(nodeView),
              programs: [...ledger.programs.values()].map(programView),
              execution: exec ? executionView(exec) : null,
              queue: ledger.queue
                .map((id) => ledger.executions.get(id))
                .filter((e) => e !== undefined)
                .map(queueEntry),
              machine,
            }
          : base,
    });
  }
  return effects;
}

function onPing(ledger: Ledger, connId: string, now: number): Effect[] {
  const observer = ledger.observers.get(connId);
  if (!observer) return refuse(ledger, connId, CLOSE.invalidMessage, "ping before subscribe");
  observer.lastSeen = now;
  return [
    {
      kind: "send",
      connId,
      msg: { t: "pong", v: PROTOCOL_VERSION, gen: ledger.meta.generation, seq: ledger.meta.seq },
    },
  ];
}

/** Liveness: silent nodes are gone, silent observers are dropped, handshakes time out. */
export function sweep(ledger: Ledger, now: number): Effect[] {
  const effects: Effect[] = [];
  for (const node of [...ledger.nodes.values()]) {
    if (now - node.lastSeen > LIMITS.goneAfterMs) {
      effects.push({
        kind: "close",
        connId: node.connId,
        code: CLOSE.declaredGone,
        reason: "silent",
      });
      effects.push(...removeConnection(ledger, node.connId, "silent"));
    }
  }
  for (const observer of [...ledger.observers.values()]) {
    if (now - observer.lastSeen > OBSERVER_SILENCE_MS) {
      effects.push({
        kind: "close",
        connId: observer.connId,
        code: CLOSE.declaredGone,
        reason: "silent",
      });
      effects.push(...removeConnection(ledger, observer.connId, "silent"));
    }
  }
  for (const conn of [...ledger.conns.values()]) {
    const handshaken = ledger.nodeByConn.has(conn.connId) || ledger.observers.has(conn.connId);
    if (!handshaken && now - conn.openedAt > HANDSHAKE_TIMEOUT_MS) {
      effects.push({
        kind: "close",
        connId: conn.connId,
        code: CLOSE.invalidMessage,
        reason: "no hello",
      });
      ledger.conns.delete(conn.connId);
    }
  }
  return effects;
}

/** Close a connection with a reason code and forget everything about it. */
function refuse(ledger: Ledger, connId: string, code: number, reason: string): Effect[] {
  const effects: Effect[] = [{ kind: "close", connId, code, reason }];
  effects.push(...removeConnection(ledger, connId, "closed"));
  return effects;
}

/** Forget a connection. A node's departure releases its work and is announced; an observer's is not. */
export function removeConnection(
  ledger: Ledger,
  connId: string,
  reason: "closed" | "silent",
): Effect[] {
  const effects: Effect[] = [];
  const nodeId = ledger.nodeByConn.get(connId);
  if (nodeId !== undefined) {
    const node = ledger.nodes.get(nodeId);
    ledger.nodes.delete(nodeId);
    ledger.nodeByConn.delete(connId);
    ledger.conns.delete(connId);
    effects.push(...broadcast(ledger, { t: "nodeLeft", nodeId, reason }));
    if (node) effects.push(...releaseNode(ledger, node));
    return effects;
  }
  ledger.observers.delete(connId);
  ledger.conns.delete(connId);
  return effects;
}

function nodeOf(ledger: Ledger, connId: string): NodeRecord | undefined {
  const nodeId = ledger.nodeByConn.get(connId);
  return nodeId === undefined ? undefined : ledger.nodes.get(nodeId);
}

/**
 * The per-observer launch rate (design §5.5): a launch or a follow-up costs one token a minute.
 * Returns a message when the observer is over, null when it may proceed.
 */
function launchRateExceeded(ledger: Ledger, connId: string, now: number): string | null {
  const observer = ledger.observers.get(connId);
  if (!observer) return null;
  observer.launchedAt = observer.launchedAt.filter((at) => now - at < 60_000);
  if (observer.launchedAt.length >= ledger.config.launchesPerMinute) {
    return `at most ${ledger.config.launchesPerMinute} launches a minute`;
  }
  observer.launchedAt.push(now);
  return null;
}
