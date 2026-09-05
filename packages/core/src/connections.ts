// Connections (design §6.2, §6.4): who is on a socket, and how a connection is refused, swept, or
// forgotten.
import {
  CLOSE,
  type ControlPlaneToNode,
  type ControlPlaneToObserver,
  LIMITS,
  PROTOCOL_VERSION,
} from "@tabframe/protocol";
import { resumeMachine } from "./advance.ts";
import type { Effect } from "./events.ts";
import { unlinkCloudCore } from "./fleet.ts";
import type { ConnRole, Ledger, NodeRecord } from "./ledger.ts";
import { broadcast, errorMsg } from "./observers.ts";
import { HANDSHAKE_TIMEOUT_MS, OBSERVER_SILENCE_MS } from "./policy.ts";
import { releaseNode } from "./scheduler.ts";

/** The node on a connection, once it has said hello. */
export function nodeOf(ledger: Ledger, connId: string): NodeRecord | undefined {
  const nodeId = ledger.nodeByConn.get(connId);
  return nodeId === undefined ? undefined : ledger.nodes.get(nodeId);
}

/** Close a connection with a reason code and forget everything about it. */
export function refuse(
  ledger: Ledger,
  connId: string,
  code: number,
  reason: string,
  now: number,
): Effect[] {
  const effects: Effect[] = [{ kind: "close", connId, code, reason }];
  effects.push(...removeConnection(ledger, connId, "closed", now));
  return effects;
}

/** Forget a connection. A node's departure releases its work and is announced; an observer's is not. */
export function removeConnection(
  ledger: Ledger,
  connId: string,
  reason: "closed" | "silent",
  now: number,
): Effect[] {
  const effects: Effect[] = [];
  const nodeId = ledger.nodeByConn.get(connId);
  if (nodeId !== undefined) {
    const node = ledger.nodes.get(nodeId);
    ledger.nodes.delete(nodeId);
    ledger.nodeByConn.delete(connId);
    ledger.conns.delete(connId);
    unlinkCloudCore(ledger, nodeId, now);
    effects.push(...broadcast(ledger, { t: "nodeLeft", nodeId, reason }));
    if (node) effects.push(...releaseNode(ledger, node));
    return effects;
  }
  // The pause holder's socket went away: the machine resumes by itself.
  if (ledger.session.pausedBy === connId) effects.push(...resumeMachine(ledger, now));
  ledger.observers.delete(connId);
  ledger.conns.delete(connId);
  return effects;
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
      effects.push(...removeConnection(ledger, node.connId, "silent", now));
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
      effects.push(...removeConnection(ledger, observer.connId, "silent", now));
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

/**
 * The answer to a presign once its budget was charged. A connection over its own budget is
 * closed; over the machine's budget a node gets a `presigned` with no URLs — its task is released
 * and retried, and closing it for someone else's spending would lose the result it was about to
 * send — while an observer is told why.
 */
export function presignReply(
  ledger: Ledger,
  connId: string,
  role: ConnRole,
  charged: "ok" | "connection" | "machine",
  items: Array<{ hash: string; size: number }>,
  now: number,
): Effect[] {
  if (charged === "connection")
    return refuse(ledger, connId, CLOSE.rateLimited, "presign budget exhausted", now);
  if (charged === "machine") {
    const msg: ControlPlaneToNode | ControlPlaneToObserver =
      role === "node"
        ? { t: "presigned", v: PROTOCOL_VERSION, gen: ledger.meta.generation, urls: [] }
        : errorMsg(
            ledger,
            "presign-budget",
            "the machine's upload budget for this minute is spent; try again shortly",
          );
    return [{ kind: "send", connId, msg }];
  }
  return [{ kind: "presign", connId, items }];
}
