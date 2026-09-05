// The one kick after anything changed: the loop's launch if it is due, the next queued execution,
// and every free slot filled. Appended to the tail of every control and handler that changed
// something, so no state waits for a tick.
import type { Effect } from "./events.ts";
import { enqueue, maybeStart } from "./execution.ts";
import type { Ledger } from "./ledger.ts";
import { loopLaunch, unyieldLoop } from "./loop.ts";
import { broadcast } from "./observers.ts";
import { fill } from "./scheduler.ts";

export function advance(ledger: Ledger, now: number): Effect[] {
  const effects: Effect[] = [];
  const launch = loopLaunch(ledger, now);
  if (launch) {
    effects.push(...unyieldLoop(ledger));
    effects.push(...enqueue(ledger, launch, now).effects);
  }
  effects.push(...maybeStart(ledger, now));
  effects.push(...fill(ledger, now));
  return effects;
}

/** Lift a pause, tell the observers, and let the machine pick up where it stopped. */
export function resumeMachine(ledger: Ledger, now: number): Effect[] {
  if (ledger.session.pausedBy === null) return [];
  ledger.session.pausedBy = null;
  const effects = broadcast(ledger, { t: "controlApplied", op: "resume", nodeIds: [] });
  effects.push(...advance(ledger, now));
  return effects;
}
