// Handover and drain, the control plane's half of a rotation (design §9.4). The fleet drives the
// order; the core only knows how to stop, hand its ledger over, and let its clients go.
import { CLOSE, type RotatingReason } from "@tabframe/protocol";
import type { Effect } from "./events.ts";
import type { Ledger } from "./ledger.ts";
import { broadcast } from "./observers.ts";
import { JITTER_FLOOR_MS, JITTER_MS_PER_CLIENT } from "./policy.ts";
import { serializeLedger } from "./snapshot.ts";

/** The window every client's reconnect delay is drawn from at a drain (design §8.4). */
export function jitterWindowMs(clients: number): number {
  return Math.max(JITTER_FLOOR_MS, clients * JITTER_MS_PER_CLIENT);
}

/**
 * Step 2 of a handover: stop assigning and pause intake, then serialize. Idempotent — a second
 * call returns the same ledger, which is what makes a retried rotation safe.
 */
export function beginHandover(
  ledger: Ledger,
  now = Date.now(),
): { json: string; generation: number } {
  if (ledger.meta.phase !== "handing-over") ledger.session.handoverAt = now;
  ledger.meta.phase = "handing-over";
  return { json: serializeLedger(ledger), generation: ledger.meta.generation };
}

/**
 * Step 5: tell the observers a rotation is happening, then close every client with the
 * rotating-reconnect code and its own delay, drawn uniformly from a window sized to the client
 * count. Spreading the reconnects keeps the session function and the MicroVM endpoint under their
 * limits when a few hundred clients come back at once.
 */
export function drain(ledger: Ledger, next: number, rng: () => number): Effect[] {
  const clients = ledger.conns.size;
  const window = jitterWindowMs(clients);
  const effects: Effect[] = broadcast(ledger, {
    t: "controlPlaneRotating",
    next,
    reconnectAfterMs: Math.round(window / 2),
  });
  for (const connId of ledger.conns.keys()) {
    const reason: RotatingReason = {
      gen: ledger.meta.generation,
      next,
      reconnectAfterMs: Math.round(rng() * window),
    };
    effects.push({
      kind: "close",
      connId,
      code: CLOSE.rotatingReconnect,
      reason: JSON.stringify(reason),
    });
  }
  ledger.meta.phase = "drained";
  return effects;
}
