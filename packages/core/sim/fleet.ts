// The process's fleet layer (design §6.8) as the simulation runs it. The core decides what the
// machine wants and says so with `launchCore` and `terminateCore`; this turns those into MicroVMs
// — virtual machines that take a couple of seconds to boot, dial in as ordinary nodes named
// `core-<microvmId>`, and stop existing when their VM is destroyed.
// packages/control-plane/src/cores.ts is the real thing, with one difference called out at
// `reconcile` below.
import type { Event } from "../src/events.ts";
import {
  CORE_LAUNCH_GAP_MS,
  DESIRED_CORES,
  SLEEP_AFTER_NO_INTERACTION_MS,
  SLEEP_AFTER_NO_OBSERVER_MS,
} from "../src/fleet.ts";
import type { Ledger } from "../src/ledger.ts";
import type { NodeProfile, VirtualNode } from "./node.ts";
import type { VirtualObserver } from "./observer.ts";
import type { WorldApi } from "./types.ts";

/** RunMicrovm answers as soon as the MicroVM exists; the process records the id then. */
const RUN_API_MS: [number, number] = [150, 500];
/** Boot to a node dialling in: about two seconds measured, plus the session round trip (§9.6). */
const BOOT_MS: [number, number] = [1_800, 3_200];
const TERMINATE_API_MS: [number, number] = [100, 300];
/** How often the process asks which of its cores are still serving. */
export const RECONCILE_MS = 5_000;

interface Microvm {
  microvmId: string;
  alive: boolean;
  launchedAt: number;
  node: VirtualNode | null;
}

export interface FleetWorld extends WorldApi {
  readonly ledger: Ledger;
  spawnNode(profile: NodeProfile): VirtualNode;
  dispatch(event: Event): void;
}

/**
 * The fleet as the process runs it, plus the policy checks of §6.8. Everything it asserts is
 * something the pure core promises; where the core promises less than the design says, the
 * simulation counts it (`coresAdrift`) instead of failing, and the work package's document says
 * so.
 */
export class SimFleet {
  private readonly world: FleetWorld;
  private readonly vms = new Map<string, Microvm>();
  private counter = 0;
  private lastLaunchAt: number | null = null;
  /** When each core record lost its node, for the adrift measurement. */
  private readonly adriftSince = new Map<string, number>();
  /** Awake/asleep bookkeeping, so an announcement can be counted against a transition. */
  private awake = true;
  private sleptAt: number | null = null;
  private announcementsThisSleep = 0;

  constructor(world: FleetWorld) {
    this.world = world;
    this.scheduleReconcile();
  }

  // --- effects ------------------------------------------------------------------------------

  /** `launchCore`: RunMicrovm, then a boot, then a node like any other. */
  launch(): void {
    const microvmId = `microvm-sim-${++this.counter}`;
    const vm: Microvm = { microvmId, alive: true, launchedAt: this.world.now, node: null };
    this.vms.set(microvmId, vm);
    this.world.stats.coresLaunched += 1;
    this.world.note(`fleet launches ${microvmId}`);
    this.world.after(this.world.between(...RUN_API_MS), () => {
      if (!vm.alive) return;
      this.world.dispatch({ kind: "coreLaunched", microvmId });
    });
    this.world.after(this.world.between(...BOOT_MS), () => {
      if (!vm.alive) return;
      vm.node = this.world.spawnNode({
        hostId: `core-${microvmId}`,
        kind: "core",
        // A quarter vCPU that bursts to one: slower than a laptop tab, and steady.
        speed: Math.round((1.4 + this.world.random() * 1.4) * 100) / 100,
        liar: false,
        fleet: true,
      });
      this.world.stats.coreJoins += 1;
      vm.node.join();
    });
  }

  /** `terminateCore`: the ledger has already forgotten it; the MicroVM goes away. */
  terminate(microvmId: string): void {
    this.world.stats.coresTerminated += 1;
    const vm = this.vms.get(microvmId);
    if (!vm) return;
    this.world.after(this.world.between(...TERMINATE_API_MS), () => this.destroy(vm));
  }

  /** The chaos generator kills a MicroVM: the fleet must notice and replace it. */
  killMicrovm(microvmId: string): void {
    const vm = this.vms.get(microvmId);
    if (!vm?.alive) return;
    this.world.stats.coresKilled += 1;
    this.destroy(vm);
  }

  /** MicroVM ids the ledger knows and whose machine is alive with a node on it. */
  liveCores(): string[] {
    const out: string[] = [];
    for (const core of this.world.ledger.cores.values()) {
      const vm = this.vms.get(core.microvmId);
      if (vm?.alive && vm.node?.connected === true) out.push(core.microvmId);
    }
    return out;
  }

  coreCount(): number {
    return this.world.ledger.cores.size;
  }

  /** Every fleet node, so a drill can tell them from tabs. */
  nodesOf(microvmIds: string[]): VirtualNode[] {
    const out: VirtualNode[] = [];
    for (const id of microvmIds) {
      const node = this.vms.get(id)?.node;
      if (node) out.push(node);
    }
    return out;
  }

  private destroy(vm: Microvm): void {
    if (!vm.alive) return;
    vm.alive = false;
    vm.node?.kill();
  }

  /**
   * The one thing the simulation does that packages/control-plane does not yet: ask which of the
   * ledger's cores are still serving and report the rest. `CoreFleet.gone()` exists for exactly
   * this and nothing calls it (WP3.3 left it for M4). Without it a core whose MicroVM dies keeps
   * its record until the four-hour ceiling and is never replaced, which is less than §6.8
   * promises — recorded in the work package's document.
   */
  private reconcile(): void {
    for (const core of this.world.ledger.cores.values()) {
      const vm = this.vms.get(core.microvmId);
      if (vm?.alive) continue;
      this.world.dispatch({ kind: "coreGone", microvmId: core.microvmId });
    }
  }

  private scheduleReconcile(): void {
    this.world.after(RECONCILE_MS, () => {
      this.reconcile();
      this.scheduleReconcile();
    });
  }

  // --- the policy, checked after every event -------------------------------------------------

  /**
   * §6.8 as properties: never more cores than wanted, launches a second apart, no cores and no
   * automatic continuation while asleep, and one announcement per sleep.
   */
  check(sleepingAnnouncements: number): void {
    const ledger = this.world.ledger;
    const cores = ledger.cores;
    if (cores.size > DESIRED_CORES)
      this.world.violation(
        `the ledger holds ${cores.size} cores, the fleet wants ${DESIRED_CORES}`,
      );

    // A record with no node behind it is the machine short-handed. A few seconds of it is normal
    // (a MicroVM booting, a core reconnecting); a long one means the fleet is counting records
    // rather than working cores, which is measured here and discussed in the work package.
    for (const core of cores.values()) {
      if (core.nodeId !== null) {
        this.adriftSince.delete(core.microvmId);
        continue;
      }
      const since = this.adriftSince.get(core.microvmId) ?? this.world.now;
      this.adriftSince.set(core.microvmId, since);
      const ms = this.world.now - since;
      if (ms > this.world.stats.coresAdriftMs) this.world.stats.coresAdriftMs = ms;
    }
    for (const id of [...this.adriftSince.keys()]) if (!cores.has(id)) this.adriftSince.delete(id);

    if (!ledger.meta.awake) {
      if (cores.size > 0)
        this.world.violation(`asleep with ${cores.size} cores still in the ledger`);
      for (const exec of ledger.executions.values()) {
        if (!exec.human && this.sleptAt !== null && exec.queuedAt > this.sleptAt)
          this.world.violation(`${exec.executionId} was queued automatically while asleep`);
      }
    }

    // Awake ⇄ asleep, and the announcement that goes with it.
    if (this.awake && !ledger.meta.awake) {
      this.awake = false;
      this.sleptAt = this.world.now;
      this.announcementsThisSleep = 0;
      this.world.stats.sleeps += 1;
      const reason = ledger.meta.sleepReason ?? "";
      const quiet = this.world.now - ledger.meta.lastObserverAt;
      const idle = this.world.now - ledger.meta.lastInteractionAt;
      if (
        !(quiet >= SLEEP_AFTER_NO_OBSERVER_MS && ledger.observers.size === 0) &&
        !(idle >= SLEEP_AFTER_NO_INTERACTION_MS)
      ) {
        this.world.violation(`slept early: ${reason} after ${quiet} ms quiet, ${idle} ms idle`);
      }
      this.world.note(`machine asleep: ${reason}`);
    } else if (!this.awake && ledger.meta.awake) {
      this.awake = true;
      this.sleptAt = null;
      this.world.stats.wakes += 1;
      this.world.note("machine awake");
    }
    if (!this.awake) {
      this.announcementsThisSleep += sleepingAnnouncements;
      if (this.announcementsThisSleep > 1)
        this.world.violation(
          `${this.announcementsThisSleep} machineSleeping announcements for one sleep`,
        );
    } else if (sleepingAnnouncements > 0) {
      this.world.violation("machineSleeping announced while awake");
    }

    if (this.lastLaunchAt !== null && ledger.meta.lastCoreLaunchAt > this.lastLaunchAt) {
      const gap = ledger.meta.lastCoreLaunchAt - this.lastLaunchAt;
      if (gap < CORE_LAUNCH_GAP_MS)
        this.world.violation(`two core launches ${gap} ms apart, the gap is ${CORE_LAUNCH_GAP_MS}`);
    }
    if (ledger.meta.lastCoreLaunchAt > 0) this.lastLaunchAt = ledger.meta.lastCoreLaunchAt;
  }
}

/** The world a drill drives: the fleet's, plus the clients it needs to add and remove. */
export interface DrillWorld extends FleetWorld {
  readonly observers: VirtualObserver[];
  spawnObserver(): VirtualObserver;
  killCore(microvmId: string): void;
}

type Step = "kill" | "replaced" | "sleeping" | "asleep" | "waking" | "done";

/** How long each step may take before the simulation calls it a stall. */
const REPLACE_BUDGET_MS = 45_000;
const SLEEP_BUDGET_MS = SLEEP_AFTER_NO_OBSERVER_MS + 90_000;
const WAKE_BUDGET_MS = 90_000;

/**
 * The fleet drill: what the chaos phase cannot reach on its own, run once after the machine has
 * settled. A cloud core's MicroVM is destroyed and must be replaced; every observer leaves and the
 * machine must fall asleep and give its cores back; a visitor returns and the machine must wake,
 * launch cores again, and start rendering. Each step has a budget, and missing one is a violation.
 */
export class FleetDrill {
  step: Step = "kill";
  private readonly world: DrillWorld;
  private readonly fleet: SimFleet;
  private stepStartedAt: number;
  private killed: string | null = null;
  private framesAtWake = 0;

  constructor(world: DrillWorld, fleet: SimFleet) {
    this.world = world;
    this.fleet = fleet;
    this.stepStartedAt = world.now;
  }

  get done(): boolean {
    return this.step === "done";
  }

  /** Called from the run loop; advances the drill and reports a step that ran out of time. */
  poll(): void {
    const ledger = this.world.ledger;
    const elapsed = this.world.now - this.stepStartedAt;
    switch (this.step) {
      case "kill": {
        const live = this.fleet.liveCores();
        if (live.length < DESIRED_CORES) {
          // Still filling the fleet after the chaos; give it the replacement budget to get there.
          if (elapsed > REPLACE_BUDGET_MS)
            this.world.violation(
              `drill: ${live.length} of ${DESIRED_CORES} cores serving after ${elapsed} ms`,
            );
          return;
        }
        this.killed = live[0] as string;
        this.world.note(`drill: destroying ${this.killed}`);
        this.world.killCore(this.killed);
        this.advance("replaced");
        return;
      }
      case "replaced": {
        const live = this.fleet.liveCores();
        if (this.killed !== null && ledger.cores.has(this.killed)) {
          if (elapsed > REPLACE_BUDGET_MS)
            this.world.violation(
              `drill: the ledger still holds destroyed core ${this.killed} after ${elapsed} ms`,
            );
          return;
        }
        if (live.length < DESIRED_CORES) {
          if (elapsed > REPLACE_BUDGET_MS)
            this.world.violation(
              `drill: a destroyed core was not replaced within ${elapsed} ms (${live.length} serving)`,
            );
          return;
        }
        this.world.note("drill: the destroyed core was replaced");
        for (const o of this.world.observers) if (o.connected) o.leave();
        this.advance("sleeping");
        return;
      }
      case "sleeping": {
        // Nobody is watching: the machine must sleep and give its cores back (§6.8).
        for (const o of this.world.observers) if (o.connected) o.leave();
        if (ledger.meta.awake) {
          if (elapsed > SLEEP_BUDGET_MS)
            this.world.violation(
              `drill: awake ${elapsed} ms after the last observer left (${ledger.observers.size} observers)`,
            );
          return;
        }
        if (!(ledger.meta.sleepReason ?? "").includes("watching"))
          this.world.violation(`drill: slept for the wrong reason: ${ledger.meta.sleepReason}`);
        if (ledger.cores.size !== 0)
          this.world.violation(`drill: asleep with ${ledger.cores.size} cores`);
        this.world.note("drill: asleep");
        this.advance("asleep");
        return;
      }
      case "asleep": {
        // A visitor arrives: the machine wakes, the fleet comes back, the loop starts again.
        this.framesAtWake = this.world.stats.framesDone;
        this.world.spawnObserver().join();
        this.advance("waking");
        return;
      }
      case "waking": {
        const live = this.fleet.liveCores();
        const rendering =
          this.world.stats.framesDone > this.framesAtWake || ledger.running !== null;
        if (ledger.meta.awake && live.length >= DESIRED_CORES && rendering) {
          this.world.note("drill: awake, fleet back, rendering");
          this.advance("done");
          return;
        }
        if (elapsed > WAKE_BUDGET_MS) {
          this.world.violation(
            `drill: ${elapsed} ms after a visitor returned the machine is ${ledger.meta.awake ? "awake" : "asleep"} with ${live.length} cores${rendering ? "" : " and nothing running"}`,
          );
          this.advance("done");
        }
        return;
      }
      case "done":
        return;
    }
  }

  private advance(next: Step): void {
    this.step = next;
    this.stepStartedAt = this.world.now;
  }
}
