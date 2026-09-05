import type { Config } from "./config.ts";
import type { Inflight } from "./inflight.ts";
import type { Lifecycle } from "./lifecycle.ts";
import type { Log } from "./log.ts";
import type { SnapshotWriter } from "./snapshot-policy.ts";
import type { ProcessState } from "./state.ts";

export interface LoopDeps {
  state: ProcessState;
  config: Pick<Config, "tickMs" | "coreCheckMs" | "snapshotEveryMs">;
  lifecycle: Lifecycle;
  snapshots: SnapshotWriter;
  inflight: Inflight;
  /** The tick found a handover lease run out. */
  onLeaseExpired: () => Promise<void>;
  log: Log;
}

/** The three timers: the core's tick, the core reaper, and the snapshot writer. Returns the stop. */
export function startLoops(deps: LoopDeps): () => void {
  const { state, lifecycle, inflight, log } = deps;
  const tick = setInterval(() => {
    const ledger = state.ledger;
    if (!ledger) return;
    const before = ledger.meta.phase;
    state.dispatch({ kind: "tick" });
    if (before === "handing-over" && ledger.meta.phase === "active")
      inflight.track(deps.onLeaseExpired());
  }, deps.config.tickMs);
  // The core's fleet policy counts records; only a `coreGone` removes one. Without this poll a
  // core whose MicroVM died would keep its record until the age ceiling and never be replaced.
  const reaper = setInterval(() => {
    const ledger = state.ledger;
    const fleet = lifecycle.cores();
    if (!ledger || state.role !== "control-plane" || !fleet || ledger.cores.size === 0) return;
    const ids = [...ledger.cores.keys()];
    inflight.track(
      fleet
        .gone(ids)
        .then((dead) => {
          for (const microvmId of dead) {
            log("core-gone", { microvmId });
            state.dispatch({ kind: "coreGone", microvmId });
          }
        })
        .catch((err) => log("core-check-failed", { error: String(err) })),
    );
  }, deps.config.coreCheckMs);
  const snapshots = setInterval(
    () => inflight.track(deps.snapshots.tick()),
    deps.config.snapshotEveryMs,
  );
  return () => {
    clearInterval(tick);
    clearInterval(reaper);
    clearInterval(snapshots);
  };
}
