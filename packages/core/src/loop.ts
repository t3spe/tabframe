// The machine's default loop (design §6.7, §6.8, D4, D19): when it may run, what it launches, how
// it backs off, and how it yields to people. Decisions only — `execution.ts` and `advance.ts` act
// on them, so the order of effects is theirs.
import type { Effect } from "./events.ts";
import type { ExecutionRecord, LaunchRequest, Ledger } from "./ledger.ts";
import { broadcast } from "./observers.ts";
import { LOOP_BACKOFF_MAX_MS, LOOP_BACKOFF_MIN_MS, YIELD_IDLE_MS } from "./policy.ts";

export function isDefaultLoop(ledger: Ledger, exec: ExecutionRecord): boolean {
  return !exec.human && ledger.config.defaultLoop?.bundle === exec.bundle;
}

/** The loop's gate for automatic work: not after Stop, not while paused, not while yielded to a person who is still around. */
export function loopMayRun(ledger: Ledger, now: number): boolean {
  if (ledger.meta.loopStopped || ledger.session.pausedBy !== null) return false;
  // Nobody has touched the page for a while: the loop may come back (`unyieldLoop` when it does).
  return !ledger.meta.loopYielded || now - ledger.meta.lastInteractionAt >= YIELD_IDLE_MS;
}

/**
 * What the loop would launch now, or null: nothing while work runs or waits, nobody watches, the
 * gate is shut, the machine sleeps, a backoff holds, or the program is gone.
 */
export function loopLaunch(ledger: Ledger, now: number): LaunchRequest | null {
  const loop = ledger.config.defaultLoop;
  if (!loop || ledger.running || ledger.queue.length > 0 || ledger.observers.size === 0)
    return null;
  if (!loopMayRun(ledger, now)) return null;
  if (!ledger.meta.awake) return null;
  if (now < (ledger.meta.loopPausedUntil ?? 0)) return null;
  if (!ledger.programs.has(loop.bundle)) return null;
  return { bundle: loop.bundle, params: loop.params, human: false, inherit: null };
}

/**
 * The follow-up a finished frame offers (D19): only the loop's own frames continue, not after a
 * Stop or while the loop has yielded, and only while someone is watching.
 */
export function loopContinuation(ledger: Ledger, exec: ExecutionRecord): LaunchRequest | null {
  if (exec.human || ledger.meta.loopStopped || ledger.meta.loopYielded || !exec.followUp)
    return null;
  if (!ledger.config.defaultLoop || exec.bundle !== ledger.config.defaultLoop.bundle) return null;
  if (ledger.observers.size === 0) return null;
  return { bundle: exec.bundle, params: exec.followUp, human: false, inherit: exec.executionId };
}

/** A loop frame ended: a success resets the backoff, a failure doubles it so a failing loop does not spin. */
export function loopEnded(
  ledger: Ledger,
  exec: ExecutionRecord,
  status: "done" | "failed" | "cancelled",
  now: number,
): void {
  if (!isDefaultLoop(ledger, exec)) return;
  if (status === "done") ledger.meta.loopBackoffMs = 0;
  if (status === "failed") {
    const delay = Math.min(
      Math.max(ledger.meta.loopBackoffMs * 2, LOOP_BACKOFF_MIN_MS),
      LOOP_BACKOFF_MAX_MS,
    );
    ledger.meta.loopBackoffMs = delay;
    ledger.meta.loopPausedUntil = now + delay;
  }
}

/**
 * The loop yields to people: once a person's launch has ended — done, failed, or killed — the
 * loop launches nothing, neither a new frame nor a queued continuation, until Start is pressed or
 * nobody has touched the machine for `YIELD_IDLE_MS`. The result stays on the stage meanwhile.
 */
export function yieldLoop(ledger: Ledger, exec: ExecutionRecord): Effect[] {
  if (!exec.human || ledger.meta.loopYielded) return [];
  ledger.meta.loopYielded = true;
  return broadcast(ledger, { t: "loopYielded", yielded: true });
}

/** The loop takes the stage back and says so. */
export function unyieldLoop(ledger: Ledger): Effect[] {
  if (!ledger.meta.loopYielded) return [];
  ledger.meta.loopYielded = false;
  return broadcast(ledger, { t: "loopYielded", yielded: false });
}
