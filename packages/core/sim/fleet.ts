// The process's fleet layer (design §6.8) as the simulation runs it. The core decides what the
// machine wants and says so with `launchCore` and `terminateCore`; this turns those into MicroVMs
// — virtual machines that take a couple of seconds to boot, dial in as ordinary nodes named
// `core-<microvmId>`, and stop existing when their VM is destroyed. packages/control-plane/src/cores.ts
// is the real thing. The §6.8 policy checks live in properties.ts.
import type { Event } from "@tabframe/core";
import {
  DESIRED_CLOUD_CORES,
  type Ledger,
  SLEEP_AFTER_NO_OBSERVER_MS,
} from "@tabframe/core/testing";
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

/** The fleet as the process runs it: MicroVMs that boot, join, die, and are reported gone. */
export class SimFleet {
  private readonly world: FleetWorld;
  private readonly vms = new Map<string, Microvm>();
  private counter = 0;

  constructor(world: FleetWorld) {
    this.world = world;
    this.scheduleReconcile();
  }

  /** `launchCore`: RunMicrovm, then a boot, then a node like any other. */
  launch(): void {
    const microvmId = `microvm-sim-${++this.counter}`;
    const vm: Microvm = { microvmId, alive: true, launchedAt: this.world.now, node: null };
    this.vms.set(microvmId, vm);
    this.world.stats.coresLaunched += 1;
    this.world.note(`fleet launches ${microvmId}`);
    const token = `sim-token-${microvmId}`.padEnd(32, "0");
    this.world.after(this.world.between(...RUN_API_MS), () => {
      if (!vm.alive) return;
      this.world.dispatch({ kind: "coreLaunched", microvmId, token });
    });
    this.world.after(this.world.between(...BOOT_MS), () => {
      if (!vm.alive) return;
      vm.node = this.world.spawnNode({
        hostId: `core-${microvmId}`,
        coreToken: token,
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

  /** Ask which of the ledger's cores are still serving and report the rest gone, as the process's reaper does. */
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
        if (live.length < DESIRED_CLOUD_CORES) {
          // Still filling the fleet after the chaos; give it the replacement budget to get there.
          if (elapsed > REPLACE_BUDGET_MS)
            this.world.violation(
              `drill: ${live.length} of ${DESIRED_CLOUD_CORES} cores serving after ${elapsed} ms`,
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
        if (live.length < DESIRED_CLOUD_CORES) {
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
        if (ledger.meta.awake && live.length >= DESIRED_CLOUD_CORES && rendering) {
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
