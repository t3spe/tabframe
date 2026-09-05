import type { Clock, Ledger } from "@tabframe/core";
import type { Authority } from "./authority.ts";
import type { Role } from "./config.ts";
import type { Log } from "./log.ts";
import type { Snapshotter } from "./snapshotter.ts";
import type { Phase, ProcessState } from "./state.ts";

export type SnapshotReason = "timer" | "suspend" | "terminate" | "handover" | "drain" | "test";

/**
 * The one gate for `latest` (design §9.4). Only a control plane writes. On the timer only the
 * named, active one writes: a predecessor after its handover and a successor before its adopt
 * both must not. The hooks write while active; a handover writes the ledger it hands over. A
 * control plane that handed over or drained writes nothing else: the successor owns the lineage,
 * and a heal must not boot from a drained predecessor's ledger.
 */
export function mayWriteSnapshot(
  view: { role: Role; phase: Phase; authoritative: boolean },
  reason: SnapshotReason,
): boolean {
  if (view.role !== "control-plane") return false;
  switch (reason) {
    case "handover":
    case "test":
      return true;
    case "timer":
      return view.phase === "active" && view.authoritative;
    default:
      return view.phase === "active";
  }
}

export interface SnapshotWriter {
  /** The hooks' and the rotation's writes: forced, failures logged; the key written, or null. */
  now(reason: Exclude<SnapshotReason, "timer" | "test">): Promise<string | null>;
  /** The timer's write: only when the ledger changed; failures logged. */
  tick(): Promise<void>;
  /** The test seam: write, forced or not, and let failures throw. */
  probe(force: boolean): Promise<string | null>;
}

export function createSnapshotWriter(deps: {
  state: ProcessState;
  authority: Authority;
  snapshotter: Snapshotter;
  clock: Clock;
  log: Log;
}): SnapshotWriter {
  const { state, snapshotter, clock, log } = deps;
  const allowed = (reason: SnapshotReason): Ledger | null => {
    const ledger = state.ledger;
    if (!ledger) return null;
    const view = {
      role: state.role,
      phase: state.phase(),
      authoritative: deps.authority.authoritative,
    };
    return mayWriteSnapshot(view, reason) ? ledger : null;
  };
  return {
    async now(reason) {
      const ledger = allowed(reason);
      if (!ledger) return null;
      try {
        const key = await snapshotter.write(ledger, clock.now(), true);
        log("snapshot", { reason, key });
        return key;
      } catch (err) {
        log("snapshot-failed", { reason, error: String(err) });
        return null;
      }
    },
    async tick() {
      const ledger = allowed("timer");
      if (!ledger) return;
      try {
        await snapshotter.write(ledger, clock.now());
      } catch (err) {
        log("snapshot-failed", { error: String(err) });
      }
    },
    probe(force) {
      const ledger = allowed("test");
      return ledger ? snapshotter.write(ledger, clock.now(), force) : Promise.resolve(null);
    },
  };
}
