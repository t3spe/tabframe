import type { Health, NodeKind, NodeView } from "@tabframe/protocol";

/** One live node. Everything the control plane knows about a core (design §6.2). */
export interface NodeRecord {
  nodeId: string;
  connId: string;
  hostId: string;
  kind: NodeKind;
  cores: number;
  sandboxVersion: string;
  joinedAt: number;
  lastSeen: number;
  visible: boolean;
  health: Health;
  tasksDone: number;
  lastTaskMs: number | null;
  /** Attempt ids in flight on this node. Filled from WP1.2 on. */
  inFlight: string[];
}

/** One dashboard connection. */
export interface ObserverRecord {
  connId: string;
  subscribedAt: number;
  lastSeen: number;
}

export type ConnRole = "node" | "observer";

/** Per-connection state the control plane keeps before and after a hello or subscribe. */
export interface ConnState {
  connId: string;
  role: ConnRole;
  openedAt: number;
  /** Token bucket for the per-connection message rate. */
  bucket: { tokens: number; refilledAt: number };
}

export interface Meta {
  generation: number;
  /** Base URL nodes and observers fetch blobs from; handed out in welcome. */
  storeBase: string;
  /** Monotonic event sequence, incremented for every event emitted to observers. */
  seq: number;
  nodeCounter: number;
}

export interface Ledger {
  meta: Meta;
  conns: Map<string, ConnState>;
  nodes: Map<string, NodeRecord>;
  nodeByConn: Map<string, string>;
  observers: Map<string, ObserverRecord>;
}

export interface LedgerConfig {
  storeBase: string;
}

export function createLedger(generation: number, config: LedgerConfig): Ledger {
  return {
    meta: { generation, storeBase: config.storeBase, seq: 0, nodeCounter: 0 },
    conns: new Map(),
    nodes: new Map(),
    nodeByConn: new Map(),
    observers: new Map(),
  };
}

export function nodeView(n: NodeRecord): NodeView {
  return {
    nodeId: n.nodeId,
    hostId: n.hostId,
    kind: n.kind,
    health: n.health,
    visible: n.visible,
    tasksDone: n.tasksDone,
    lastTaskMs: n.lastTaskMs,
    inFlight: n.inFlight.length,
    joinedAt: n.joinedAt,
  };
}
