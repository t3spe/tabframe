// The fleet and sleep policies (design §6.8). The core decides *what* the machine wants — two
// cloud cores while awake, none while asleep — and says so with effects; the process is what
// talks to the MicroVM API.
import type { Effect } from "./events.ts";
import type { Ledger } from "./ledger.ts";
import { broadcast } from "./observers.ts";

/** How many cloud cores the machine keeps while awake. */
export const DESIRED_CORES = 2;
/** The account allows one RunMicrovm a second, so cores come up one at a time. */
export const CORE_LAUNCH_GAP_MS = 1_000;
/** A launch asked for and not acknowledged within this long is forgotten (WP8.1). */
export const CORE_LAUNCH_ACK_MS = 60_000;
/** A core is replaced before it reaches its four-hour ceiling. */
export const CORE_MAX_AGE_MS = 3.5 * 60 * 60 * 1_000;
/**
 * A core boots and says hello within seconds; one that has had no node for this long is not
 * coming (a MicroVM that booted but whose process never connected — seen once in two launches
 * during the WP4.4 demo runs) and is terminated so the policy launches another.
 */
export const CORE_LINK_TIMEOUT_MS = 2 * 60 * 1_000;
/** Asleep after this long with nobody watching. */
export const SLEEP_AFTER_NO_OBSERVER_MS = 10 * 60 * 1_000;
/** Asleep after this long with a dashboard open but nobody touching it (a tab left overnight). */
export const SLEEP_AFTER_NO_INTERACTION_MS = 60 * 60 * 1_000;

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

/**
 * One pass of the fleet and sleep policies, called on every tick. Awake: keep `DESIRED_CORES`
 * alive, one launch per second, replacing any core near its ceiling. Asleep: terminate them and
 * say so once; automatic continuation stops (see `ensureDefaultLoop`) and the control plane's own
 * idle policy suspends it a quarter of an hour later.
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
    for (const core of ledger.cores.values()) {
      effects.push({ kind: "terminateCore", microvmId: core.microvmId });
    }
    ledger.cores.clear();
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
    const unlinkedFor = core.nodeId === null ? now - (core.unlinkedAt ?? core.launchedAt) : 0;
    if (now - core.launchedAt >= CORE_MAX_AGE_MS || unlinkedFor >= CORE_LINK_TIMEOUT_MS) {
      ledger.cores.delete(core.microvmId);
      effects.push({ kind: "terminateCore", microvmId: core.microvmId });
    }
  }
  // Launches asked for and not yet acknowledged count towards the desired size (WP8.1): with a
  // half-second tick and a one-second gap, an API that takes longer than that used to be asked
  // twice. An acknowledgement that never comes expires after a minute.
  ledger.meta.coreLaunches = ledger.meta.coreLaunches.filter((t) => now - t < CORE_LAUNCH_ACK_MS);
  if (
    ledger.cores.size + ledger.meta.coreLaunches.length < DESIRED_CORES &&
    now - ledger.meta.lastCoreLaunchAt >= CORE_LAUNCH_GAP_MS
  ) {
    ledger.meta.lastCoreLaunchAt = now;
    ledger.meta.coreLaunches.push(now);
    effects.push({ kind: "launchCore" });
  }
  // More cores than wanted (an acknowledgement after its expiry, an adopted ledger's extras): the
  // youngest unlinked ones go.
  if (ledger.cores.size > DESIRED_CORES) {
    const surplus = [...ledger.cores.values()]
      .filter((c) => c.nodeId === null)
      .sort((a, b) => b.launchedAt - a.launchedAt)
      .slice(0, ledger.cores.size - DESIRED_CORES);
    for (const core of surplus) {
      ledger.cores.delete(core.microvmId);
      effects.push({ kind: "terminateCore", microvmId: core.microvmId });
    }
  }
  return effects;
}

/** The process launched a core: remember it so a handover carries it (design §6.8). */
export function coreLaunched(
  ledger: Ledger,
  microvmId: string,
  now: number,
  token?: string,
): Effect[] {
  ledger.meta.coreLaunches.shift(); // the oldest launch asked for is the one answered
  if (!ledger.cores.has(microvmId)) {
    ledger.cores.set(microvmId, {
      microvmId,
      launchedAt: now,
      nodeId: null,
      unlinkedAt: now,
      ...(token ? { token } : {}),
    });
  }
  return [];
}

/** A core's MicroVM is gone (it died, or a control killed it): forget it so it is replaced. */
export function coreGone(ledger: Ledger, microvmId: string): Effect[] {
  ledger.cores.delete(microvmId);
  return [];
}

/** `core-<microvmId>` is how a cloud core names itself; anything else is a tab or a local process. */
export function microvmIdOfHost(hostId: string): string | null {
  return hostId.startsWith("core-microvm-") ? hostId.slice("core-".length) : null;
}
