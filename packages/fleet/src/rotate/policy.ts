// What a scheduled rotation does before it touches anything. Pure: the pointer, the control plane's
// state and the clock go in; a reason to stand down, or null to go on, comes out.
import type { Pointer } from "../pointer.ts";
import type { MicrovmInfo } from "../types.ts";
import type { RotateResult } from "./index.ts";

/**
 * A scheduled rotation this soon after the last pointer change stands down: two rotations at once
 * leave a pending successor behind. An operator's `mise run rotate` is never held back.
 */
export const RECENT_ROTATION_MS = 5 * 60 * 1000;

/** A pending record younger than this belongs to a rotation still running: the function's timeout. */
export const PENDING_IN_PROGRESS_MS = 10 * 60_000;

/** A reason for a run to end early, with the line it logs. */
export interface Skip {
  result: RotateResult;
  why: string;
  fields: Record<string, unknown>;
}

/** True for an EventBridge invocation; an operator's invoke carries no `source`. */
export function isScheduledEvent(event: unknown): boolean {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as { source?: unknown }).source === "aws.events"
  );
}

/** A scheduled run minutes after the last pointer change waits for the next hour. */
export function skipIfRecent(pointer: Pointer, now: number): Skip | null {
  const updatedAt = pointer.updatedAt ? Date.parse(pointer.updatedAt) : Number.NaN;
  if (!Number.isFinite(updatedAt) || now - updatedAt >= RECENT_ROTATION_MS) return null;
  return {
    result: { action: "skipped-recent" },
    why: "rotate: a rotation ran minutes ago; the scheduled one waits for the next hour",
    fields: { ageMs: now - updatedAt },
  };
}

/**
 * A scheduled run leaves an idle control plane alone. A suspended one has nobody to serve, and one
 * the platform's ceiling ended is healed by the first visitor's session call; either way an idle
 * machine must not boot a fresh generation every hour of the night.
 */
export function skipIfIdle(pointer: Pointer, running: MicrovmInfo | null): Skip | null {
  if (running?.state === "SUSPENDED") {
    return {
      result: { action: "skipped-suspended" },
      why: "rotate: the control plane is suspended; the scheduled rotation waits for a visitor",
      fields: { microvmId: running.microvmId },
    };
  }
  if (
    !pointer.pending &&
    running &&
    (running.state === "TERMINATED" || running.state === "TERMINATING")
  ) {
    return {
      result: { action: "skipped-terminated" },
      why: "rotate: the control plane was ended by its ceiling; the heal waits for a visitor",
      fields: { microvmId: running.microvmId },
    };
  }
  return null;
}
