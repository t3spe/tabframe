import type { ControlPlaneToObserver, NodeView, Snapshot } from "@tabframe/protocol";

/** The dashboard's model of the cluster, built from snapshots and events. Pure and unit-tested. */
export interface ClusterState {
  generation: number | null;
  seq: number;
  nodes: Map<string, NodeView>;
  /** Pages of the snapshot still expected before the view is complete. */
  pagesPending: number;
  /** True once a gap in sequence numbers was seen; the client must resubscribe. */
  gap: boolean;
}

export function emptyState(): ClusterState {
  return { generation: null, seq: 0, nodes: new Map(), pagesPending: 0, gap: false };
}

export function applyMessage(state: ClusterState, msg: ControlPlaneToObserver): ClusterState {
  switch (msg.t) {
    case "snapshot":
      return applySnapshot(state, msg);
    case "pong":
      if (msg.seq > state.seq) return { ...state, gap: true };
      return state;
    case "error":
      return state;
    case "nodeJoined": {
      const next = advance(state, msg.seq);
      next.nodes.set(msg.node.nodeId, msg.node);
      return next;
    }
    case "nodeLeft": {
      const next = advance(state, msg.seq);
      next.nodes.delete(msg.nodeId);
      return next;
    }
    case "nodeHealth": {
      const next = advance(state, msg.seq);
      const n = next.nodes.get(msg.nodeId);
      if (n) next.nodes.set(msg.nodeId, { ...n, health: msg.health });
      return next;
    }
    default:
      // Execution and task events are modeled in WP1.8; until then they only advance the sequence.
      return "seq" in msg ? advance(state, msg.seq) : state;
  }
}

function applySnapshot(state: ClusterState, snap: Snapshot): ClusterState {
  const nodes = snap.page === 0 ? new Map<string, NodeView>() : new Map(state.nodes);
  for (const n of snap.nodes ?? []) nodes.set(n.nodeId, n);
  return {
    generation: snap.gen,
    seq: snap.seq,
    nodes,
    pagesPending: snap.pages - snap.page - 1,
    gap: false,
  };
}

/** Events must arrive in sequence; a skipped number means a missed event. */
function advance(state: ClusterState, seq: number): ClusterState {
  const gap = state.gap || seq !== state.seq + 1;
  return { ...state, seq: Math.max(state.seq, seq), nodes: new Map(state.nodes), gap };
}

export function hostCount(state: ClusterState): number {
  return new Set([...state.nodes.values()].map((n) => n.hostId)).size;
}
