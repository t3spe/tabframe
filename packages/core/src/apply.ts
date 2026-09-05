// The control plane as a function (design §6.1): one inbound event, the ledger updated in place,
// and the effects the process must carry out. No I/O happens here; time is a parameter.
//
// Modules import downward: policy → budgets → ledger → observers → tasks → scheduler → results →
// loop → execution → programs, retention, advance → connections → node-messages, controls, pages →
// apply; fleet, snapshot, and handover hang off ledger and execution.
import { CLOSE, decode, nodeToControlPlane, observerToControlPlane } from "@tabframe/protocol";
import { advance } from "./advance.ts";
import { BUDGETS, newBucket, take } from "./budgets.ts";
import { refuse, removeConnection, sweep } from "./connections.ts";
import { launchFor, onObserverMessage } from "./controls.ts";
import { type Effect, type Event, fetchResult } from "./events.ts";
import { onFetched, onManifestStored, resumePending } from "./execution.ts";
import { cloudCoreGone, cloudCoreLaunched, fleetTick } from "./fleet.ts";
import type { ConnRole, Ledger } from "./ledger.ts";
import { onNodeMessage } from "./node-messages.ts";
import { errorMsg } from "./observers.ts";
import { HANDOVER_LEASE_MS } from "./policy.ts";
import { addProgram, retireProgram } from "./programs.ts";
import { pruneExecutions } from "./retention.ts";
import { relabelHealth } from "./scheduler.ts";

export interface ApplyOptions {
  /** Uniform random in [0, 1); victim selection for the demo controls. */
  rng?: () => number;
}

/** One event in, the ledger updated, the effects out. */
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
      return removeConnection(ledger, event.connId, "closed", now);
    case "tick":
      return tick(ledger, now);
    case "coreLaunched":
      return cloudCoreLaunched(ledger, event.microvmId, event.token, now);
    case "coreGone":
      return cloudCoreGone(ledger, event.microvmId);
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
        ...addProgram(ledger, event.bundle, event.module, event.manifest, event.files, now),
        ...advance(ledger, now),
      ];
    case "programRetired":
      return retireProgram(ledger, event.bundle);
    case "setDefaultLoop":
      ledger.config.defaultLoop = event.loop;
      return advance(ledger, now);
    case "launch":
      return launchFor(
        ledger,
        { bundle: event.bundle, params: event.params, human: event.human, inherit: event.inherit },
        event.connId,
        now,
      );
    case "blobFetched":
      return [
        ...onFetched(ledger, event.purpose, fetchResult(event), now),
        ...advance(ledger, now),
      ];
    case "blobStored":
      return [...onManifestStored(ledger, event.purpose, event.hash, now), ...advance(ledger, now)];
  }
}

function tick(ledger: Ledger, now: number): Effect[] {
  const effects = sweep(ledger, now);
  pruneExecutions(ledger);
  // A control plane that handed its ledger over acts on nothing until it is drained: no fleet, no
  // loop, no assignment — the successor owns all of that now. Unless the rotation died between the
  // handover and the promote, in which case the lease brings this one back (design §9.4).
  if (ledger.meta.phase === "handing-over") {
    if (ledger.session.handoverAt !== null && now - ledger.session.handoverAt > HANDOVER_LEASE_MS) {
      ledger.meta.phase = "active";
      ledger.session.handoverAt = null;
    } else return effects;
  }
  if (ledger.meta.phase === "drained") return effects;
  effects.push(...fleetTick(ledger, now));
  effects.push(...relabelHealth(ledger));
  effects.push(...advance(ledger, now));
  effects.push(...resumePending(ledger, now));
  return effects;
}

function onConnected(ledger: Ledger, connId: string, role: ConnRole, now: number): Effect[] {
  if (ledger.conns.has(connId)) return [];
  ledger.conns.set(connId, {
    connId,
    role,
    openedAt: now,
    messages: newBucket(role === "node" ? BUDGETS.nodeMessages : BUDGETS.observerMessages, now),
    solicited: newBucket(BUDGETS.solicited, now),
    presignBytes: newBucket(BUDGETS.presignBytes, now),
  });
  return [];
}

/** Decode a frame against the connection's role, gate it by rate, and hand it to its handler. */
function onMessage(
  ledger: Ledger,
  connId: string,
  raw: unknown,
  now: number,
  rng: () => number,
): Effect[] {
  const conn = ledger.conns.get(connId);
  if (!conn) return [];
  const opts = { expectGen: ledger.meta.generation };
  if (conn.role === "node") {
    const d = decode(nodeToControlPlane, raw, opts);
    if (!d.ok) return refuse(ledger, connId, d.closeCode, d.reason, now);
    // Results and presigns answer assignments, which maxInFlight already paces (a fast node on
    // small tiles legitimately sends dozens a second), so they draw on a bucket of their own — a
    // node that says hello and floods presigns costs S3 calls, so it is a bounded one.
    const solicited = d.msg.t === "result" || d.msg.t === "presign";
    if (!solicited && !take(conn.messages, BUDGETS.nodeMessages, now))
      return refuse(ledger, connId, CLOSE.rateLimited, "message rate exceeded", now);
    if (
      solicited &&
      !take(conn.solicited, BUDGETS.solicited, now, d.msg.t === "presign" ? d.msg.items.length : 1)
    )
      return refuse(ledger, connId, CLOSE.rateLimited, "result rate exceeded", now);
    return onNodeMessage(ledger, connId, conn, d.msg, now);
  }
  const d = decode(observerToControlPlane, raw, opts);
  if (!d.ok) return refuse(ledger, connId, d.closeCode, d.reason, now);
  if (!take(conn.messages, BUDGETS.observerMessages, now))
    return refuse(ledger, connId, CLOSE.rateLimited, "message rate exceeded", now);
  return onObserverMessage(ledger, connId, conn, d.msg, now, rng);
}
