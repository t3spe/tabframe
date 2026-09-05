// The fleet and sleep policies (design §6.8). The core decides what the machine wants — two cloud
// cores while awake, none while asleep — and says so with effects; the process talks to the
// MicroVM API.
import type { Effect } from "./events.ts";
import type { Ledger } from "./ledger.ts";
import { broadcast } from "./observers.ts";
import {
  CLOUD_CORE_LAUNCH_ACK_MS,
  CLOUD_CORE_LAUNCH_GAP_MS,
  CLOUD_CORE_LINK_TIMEOUT_MS,
  CLOUD_CORE_MAX_AGE_MS,
  DESIRED_CLOUD_CORES,
  SLEEP_AFTER_NO_INTERACTION_MS,
  SLEEP_AFTER_NO_OBSERVER_MS,
} from "./policy.ts";

/** Why the machine would be asleep right now, or null if it should be awake. */
export function sleepReason(ledger: Ledger, now: number): string | null {
  if (ledger.observers.size > 0) {
    if (now - ledger.meta.lastInteractionAt >= SLEEP_AFTER_NO_INTERACTION_MS) {
      return "an hour without anyone touching the dashboard";
    }
    return null;
  }
  if (now - ledger.meta.lastObserverAt >= SLEEP_AFTER_NO_OBSERVER_MS) {
    return "ten minutes with nobody watching";
  }
  return null;
}

/** Forget a cloud core and have its MicroVM terminated. */
export function forgetCloudCore(ledger: Ledger, microvmId: string): Effect {
  ledger.cores.delete(microvmId);
  return { kind: "terminateCore", microvmId };
}

/** A node has gone: if it was a cloud core, the core is unlinked and replaced after the link timeout. */
export function unlinkCloudCore(ledger: Ledger, nodeId: string, now: number): void {
  for (const core of ledger.cores.values()) {
    if (core.nodeId === nodeId) {
      core.nodeId = null;
      core.unlinkedAt = now;
    }
  }
}

/**
 * One pass of the fleet and sleep policies, on every tick. Awake: keep `DESIRED_CLOUD_CORES`
 * alive, one launch per second, replacing any core near its ceiling. Asleep: terminate them and
 * say so once; the loop's gate stops automatic continuation.
 */
export function fleetTick(ledger: Ledger, now: number): Effect[] {
  if (ledger.observers.size > 0) ledger.meta.lastObserverAt = now;
  const effects: Effect[] = [];
  const reason = sleepReason(ledger, now);

  if (reason) {
    if (ledger.meta.awake) {
      ledger.meta.awake = false;
      ledger.meta.sleepReason = reason;
      effects.push(...broadcast(ledger, { t: "machineSleeping", reason }));
    }
    for (const core of [...ledger.cores.values()])
      effects.push(forgetCloudCore(ledger, core.microvmId));
    return effects;
  }
  if (!ledger.config.cloudCores) {
    // A laptop control plane has no MicroVM API; it still wakes and sleeps, it just has no fleet.
    if (!ledger.meta.awake) {
      ledger.meta.awake = true;
      ledger.meta.sleepReason = null;
    }
    return effects;
  }

  if (!ledger.meta.awake) {
    ledger.meta.awake = true;
    ledger.meta.sleepReason = null;
  }
  // Retire a core before its MicroVM ceiling, or one that has had no node for too long; the
  // replacement comes up on a later tick.
  for (const core of [...ledger.cores.values()]) {
    const unlinkedFor = core.unlinkedAt === null ? 0 : now - core.unlinkedAt;
    if (now - core.launchedAt >= CLOUD_CORE_MAX_AGE_MS || unlinkedFor >= CLOUD_CORE_LINK_TIMEOUT_MS)
      effects.push(forgetCloudCore(ledger, core.microvmId));
  }
  // Launches asked for and not yet acknowledged count towards the desired size: with a half-second
  // tick and a one-second gap, an API that takes longer would be asked twice.
  ledger.meta.coreLaunches = ledger.meta.coreLaunches.filter(
    (t) => now - t < CLOUD_CORE_LAUNCH_ACK_MS,
  );
  if (
    ledger.cores.size + ledger.meta.coreLaunches.length < DESIRED_CLOUD_CORES &&
    now - ledger.meta.lastCoreLaunchAt >= CLOUD_CORE_LAUNCH_GAP_MS
  ) {
    ledger.meta.lastCoreLaunchAt = now;
    ledger.meta.coreLaunches.push(now);
    effects.push({ kind: "launchCore" });
  }
  // More cores than wanted (an acknowledgement after its expiry, an adopted ledger's extras): the
  // youngest unlinked ones go.
  if (ledger.cores.size > DESIRED_CLOUD_CORES) {
    const surplus = [...ledger.cores.values()]
      .filter((c) => c.nodeId === null)
      .sort((a, b) => b.launchedAt - a.launchedAt)
      .slice(0, ledger.cores.size - DESIRED_CLOUD_CORES);
    for (const core of surplus) effects.push(forgetCloudCore(ledger, core.microvmId));
  }
  return effects;
}

/** The process launched a core: remember it, with the token its hello must show, so a handover carries it. */
export function cloudCoreLaunched(
  ledger: Ledger,
  microvmId: string,
  token: string,
  now: number,
): Effect[] {
  ledger.meta.coreLaunches.shift(); // the oldest launch asked for is the one answered
  if (!ledger.cores.has(microvmId)) {
    ledger.cores.set(microvmId, {
      microvmId,
      launchedAt: now,
      token,
      nodeId: null,
      unlinkedAt: now,
    });
  }
  return [];
}

/** A core's MicroVM is gone (it died, or a control killed it): forget it so it is replaced. */
export function cloudCoreGone(ledger: Ledger, microvmId: string): Effect[] {
  ledger.cores.delete(microvmId);
  return [];
}

/** `core-<microvmId>` is how a cloud core names itself; anything else is a tab or a local process. */
export function microvmIdOfHost(hostId: string): string | null {
  return hostId.startsWith("core-microvm-") ? hostId.slice("core-".length) : null;
}
