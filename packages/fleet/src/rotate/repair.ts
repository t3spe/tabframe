// What a previous run left behind between launching a successor and flipping the pointer.
import type { Pointer } from "../pointer.ts";
import { SERVING_STATES } from "../types.ts";
import type { RotateDeps, RotateResult } from "./index.ts";
import { clearPending, promote } from "./pointer-ops.ts";
import { PENDING_IN_PROGRESS_MS } from "./policy.ts";
import { retire, terminateQuietly } from "./retire.ts";

/**
 * Settle a pending successor. One another run is still adopting is left alone; one that is gone,
 * superseded, or stale beside a serving control plane is forgotten (and terminated); one serving
 * where nothing else does is promoted, finishing the interrupted rotation.
 */
export async function repair(
  deps: RotateDeps,
  p: Pointer,
  secret: string,
): Promise<RotateResult | null> {
  const { pointer, microvms, clock, log } = deps;
  const stale = p.pending;
  if (!stale) return null;
  // Younger than a run's own timeout: an operator's rotate overlapping the hourly one must not
  // terminate the successor the other run is adopting.
  if (stale.at !== undefined && clock.now() - stale.at < PENDING_IN_PROGRESS_MS) {
    log.info("rotate: another rotation is in progress; leaving its successor alone", {
      microvmId: stale.microvmId,
      ageMs: clock.now() - stale.at,
    });
    return { action: "in-progress", microvmId: stale.microvmId, generation: stale.generation };
  }
  const vm = await microvms.get(stale.microvmId);
  if (!vm || !SERVING_STATES.has(vm.state)) {
    log.warn("rotate: forgetting a pending control plane that is gone", {
      microvmId: stale.microvmId,
      state: vm?.state ?? "not-found",
    });
    await clearPending(pointer, p);
    return null;
  }
  if (stale.generation <= p.generation) {
    await terminateQuietly(deps, stale.microvmId, "superseded");
    await clearPending(pointer, p);
    return null;
  }
  // A pending successor never adopted the live ledger: it booted from a snapshot of its own and
  // has slept with it since. While the current control plane serves, promoting it would hand the
  // dashboards an old, sleeping machine; it is terminated and the rotation starts afresh.
  const running = p.microvmId ? await microvms.get(p.microvmId) : null;
  if (running && SERVING_STATES.has(running.state)) {
    log.warn("rotate: a pending successor with a stale ledger; terminating it, rotating afresh", {
      microvmId: stale.microvmId,
      generation: stale.generation,
    });
    await terminateQuietly(deps, stale.microvmId, "stale pending successor");
    await clearPending(pointer, p);
    return null;
  }
  log.info("rotate: finishing an interrupted rotation", {
    microvmId: stale.microvmId,
    generation: stale.generation,
  });
  const now = clock.now();
  const previous = p.microvmId;
  if (!(await promote(deps, p, vm, stale.generation, now))) return { action: "skipped-off" };
  if (previous && previous !== vm.microvmId) {
    await retire(
      deps,
      { microvmId: previous, endpoint: p.endpoint ?? "" },
      stale.generation,
      secret,
    );
  }
  return {
    action: "repaired",
    microvmId: vm.microvmId,
    generation: stale.generation,
    endpoint: vm.endpoint,
  };
}
