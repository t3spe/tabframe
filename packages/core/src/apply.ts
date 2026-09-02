import {
  CLOSE,
  type ControlPlaneToObserver,
  decode,
  type Heartbeat,
  type Hello,
  LIMITS,
  nodeToControlPlane,
  type ObserverEvent,
  observerToControlPlane,
  PROTOCOL_VERSION,
} from "@tabframe/protocol";
import type { Effect, Event } from "./events.ts";
import { type ConnRole, type Ledger, type NodeRecord, nodeView } from "./ledger.ts";

/** Connections that never say hello or subscribe are dropped after this long. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Observers that stop pinging are dropped after this long. */
const OBSERVER_SILENCE_MS = 5 * LIMITS.observerPingMs;

/**
 * The control plane as a function: one inbound event, the ledger updated in place, and the
 * effects the process must carry out. No I/O happens here; time is a parameter.
 */
export function apply(ledger: Ledger, event: Event, now: number): Effect[] {
  switch (event.kind) {
    case "connected":
      return onConnected(ledger, event.connId, event.role, now);
    case "message":
      return onMessage(ledger, event.connId, event.raw, now);
    case "disconnected":
      return removeConnection(ledger, event.connId, "closed");
    case "tick":
      return sweep(ledger, now);
  }
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

function onMessage(ledger: Ledger, connId: string, raw: unknown, now: number): Effect[] {
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
    }
  }
  const d = decode(observerToControlPlane, raw, opts);
  if (!d.ok) return refuse(ledger, connId, d.closeCode, d.reason);
  switch (d.msg.t) {
    case "subscribe":
      return onSubscribe(ledger, connId, now);
    case "ping":
      return onPing(ledger, connId, now);
  }
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
    inFlight: [],
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
  return effects;
}

function onHeartbeat(ledger: Ledger, connId: string, msg: Heartbeat, now: number): Effect[] {
  const node = nodeOf(ledger, connId);
  if (!node) return refuse(ledger, connId, CLOSE.invalidMessage, "heartbeat before hello");
  node.lastSeen = now;
  node.visible = msg.visible;
  node.tasksDone = msg.tasksDone;
  node.lastTaskMs = msg.lastTaskMs;

  // Throttled is the one label the node's own evidence decides: its host tab is hidden.
  // Fast versus slow comes from compute statistics and arrives with scheduling (WP1.2).
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
  if (ledger.observers.size >= LIMITS.observerCap) {
    return refuse(ledger, connId, CLOSE.observerCap, "observer cap reached");
  }
  ledger.observers.set(connId, { connId, subscribedAt: now, lastSeen: now });

  const nodes = [...ledger.nodes.values()].map(nodeView);
  const pageSize = LIMITS.snapshotPageTasks;
  const pages = Math.max(1, Math.ceil(nodes.length / pageSize));
  const effects: Effect[] = [];
  for (let page = 0; page < pages; page++) {
    effects.push({
      kind: "send",
      connId,
      msg: {
        t: "snapshot",
        v: PROTOCOL_VERSION,
        gen: ledger.meta.generation,
        seq: ledger.meta.seq,
        page,
        pages,
        nodes: nodes.slice(page * pageSize, (page + 1) * pageSize),
        at: now,
      },
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

/** Forget a connection. A node's departure is announced to observers; an observer's is not. */
function removeConnection(ledger: Ledger, connId: string, reason: "closed" | "silent"): Effect[] {
  const effects: Effect[] = [];
  const nodeId = ledger.nodeByConn.get(connId);
  if (nodeId !== undefined) {
    ledger.nodes.delete(nodeId);
    ledger.nodeByConn.delete(connId);
    ledger.conns.delete(connId);
    effects.push(...broadcast(ledger, { t: "nodeLeft", nodeId, reason }));
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

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventBody = DistributiveOmit<ObserverEvent, "v" | "gen" | "seq">;

/** Stamp an event with the next sequence number and address it to every observer. */
function broadcast(ledger: Ledger, body: EventBody): Effect[] {
  if (ledger.observers.size === 0) return [];
  const seq = ++ledger.meta.seq;
  const msg = {
    v: PROTOCOL_VERSION,
    gen: ledger.meta.generation,
    seq,
    ...body,
  } as ControlPlaneToObserver;
  return [...ledger.observers.keys()].map((connId) => ({ kind: "send", connId, msg }));
}
