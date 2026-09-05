// What a node says on its socket (design §6.2, §6.4, §6.5, D18): hello, heartbeat, result,
// presign.
import {
  CLOSE,
  type Heartbeat,
  type Hello,
  LIMITS,
  type NodeToControlPlane,
  PROTOCOL_VERSION,
} from "@tabframe/protocol";
import { advance } from "./advance.ts";
import { chargePresign } from "./budgets.ts";
import { nodeOf, presignReply, refuse } from "./connections.ts";
import type { Effect } from "./events.ts";
import { afterTaskSettled } from "./execution.ts";
import { microvmIdOfHost } from "./fleet.ts";
import { type ConnState, type Ledger, type NodeRecord, nodeView } from "./ledger.ts";
import { broadcast } from "./observers.ts";
import { HEALTH_ANNOUNCE_MS } from "./policy.ts";
import { onResult } from "./results.ts";

/** A decoded, rate-gated node message. */
export function onNodeMessage(
  ledger: Ledger,
  connId: string,
  conn: ConnState,
  msg: NodeToControlPlane,
  now: number,
): Effect[] {
  switch (msg.t) {
    case "hello":
      return onHello(ledger, connId, msg, now);
    case "heartbeat":
      return onHeartbeat(ledger, connId, msg, now);
    case "result": {
      const node = nodeOf(ledger, connId);
      if (!node) return refuse(ledger, connId, CLOSE.invalidMessage, "result before hello", now);
      node.lastSeen = now;
      const { effects, settlement } = onResult(ledger, node, msg, now);
      if (settlement.kind === "done" || settlement.kind === "failed")
        effects.push(...afterTaskSettled(ledger, settlement.task, now));
      effects.push(...advance(ledger, now));
      return effects;
    }
    case "presign": {
      const node = nodeOf(ledger, connId);
      if (!node) return refuse(ledger, connId, CLOSE.invalidMessage, "presign before hello", now);
      node.lastSeen = now;
      const charged = chargePresign(conn, ledger.session, msg.items, now);
      return presignReply(ledger, connId, "node", charged, msg.items, now);
    }
  }
}

function onHello(ledger: Ledger, connId: string, msg: Hello, now: number): Effect[] {
  if (ledger.nodeByConn.has(connId))
    return refuse(ledger, connId, CLOSE.invalidMessage, "duplicate hello", now);
  if (ledger.nodes.size >= LIMITS.nodeCap)
    return refuse(ledger, connId, CLOSE.nodeCap, "node cap reached", now);

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
    heartbeatAt: null,
    announcedHealth: null,
    healthAnnouncedAt: null,
  };
  ledger.nodes.set(nodeId, node);
  ledger.nodeByConn.set(connId, nodeId);
  // A cloud core names itself after its MicroVM and proves it with the token its run payload
  // carried: a hello links only a record the control plane launched, and only with the token, so
  // a visitor cannot name a core and get it terminated.
  const microvmId = microvmIdOfHost(msg.hostId);
  if (microvmId) {
    const core = ledger.cores.get(microvmId);
    if (core && core.token === msg.coreToken) {
      core.nodeId = nodeId;
      core.unlinkedAt = null;
    } else {
      ledger.nodes.delete(nodeId);
      ledger.nodeByConn.delete(connId);
      return refuse(ledger, connId, CLOSE.invalidMessage, "unknown core or bad core token", now);
    }
  }

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
  effects.push(...advance(ledger, now));
  return effects;
}

function onHeartbeat(ledger: Ledger, connId: string, msg: Heartbeat, now: number): Effect[] {
  const node = nodeOf(ledger, connId);
  if (!node) return refuse(ledger, connId, CLOSE.invalidMessage, "heartbeat before hello", now);
  // A heartbeat arriving faster than half the period is noise: one socket alternating `visible` a
  // thousand times a second would fan out to every observer.
  if (node.heartbeatAt !== null && now - node.heartbeatAt < LIMITS.heartbeatMs / 2) return [];
  node.heartbeatAt = now;
  node.lastSeen = now;
  node.visible = msg.visible;
  const before = node.health;
  // Throttled is the one label the node's own evidence decides: its host tab is hidden.
  if (!msg.visible && node.health !== "throttled") node.health = "throttled";
  else if (msg.visible && node.health === "throttled") node.health = "fast";
  // A flip inside the announcement window is announced by the next heartbeat that finds it still
  // changed.
  const announced = node.announcedHealth ?? before;
  if (node.health !== announced) {
    if (now - (node.healthAnnouncedAt ?? 0) < HEALTH_ANNOUNCE_MS) return [];
    node.announcedHealth = node.health;
    node.healthAnnouncedAt = now;
    return broadcast(ledger, { t: "nodeHealth", nodeId: node.nodeId, health: node.health });
  }
  return [];
}
