import { type ControlPlaneToObserver, PROTOCOL_VERSION } from "@tabframe/protocol";
import type { Effect } from "./events.ts";
import type { Ledger } from "./ledger.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Event = Exclude<
  ControlPlaneToObserver,
  { t: "snapshot" } | { t: "pong" } | { t: "error" } | { t: "presigned" }
>;
export type EventBody = DistributiveOmit<Event, "v" | "gen" | "seq">;

/** Stamp an event with the next sequence number and address it to every observer. */
export function broadcast(ledger: Ledger, body: EventBody): Effect[] {
  // The sequence advances whether or not anyone listens: the snapshot page memo keys on it, and a
  // change nobody saw must still invalidate the pages the next subscriber gets.
  const seq = ++ledger.meta.seq;
  if (ledger.observers.size === 0) return [];
  const msg = {
    v: PROTOCOL_VERSION,
    gen: ledger.meta.generation,
    seq,
    ...body,
  } as ControlPlaneToObserver;
  return [...ledger.observers.keys()].map((connId) => ({ kind: "send", connId, msg }));
}

/** An error frame for one observer: a refusal with a code the dashboard can act on. */
export function errorMsg(ledger: Ledger, code: string, message: string): ControlPlaneToObserver {
  return { t: "error", v: PROTOCOL_VERSION, gen: ledger.meta.generation, code, message };
}
