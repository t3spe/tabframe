// The seeded event generator: joins, leaves, crashes, freezes, hidden tabs, rejoins, observers
// coming and going, the demo controls, and the redundancy toggle, all drawn from the seed on the
// virtual timeline. A run has two phases: chaos until enough frames completed (or a virtual time
// cap), then calm, where the generator stops, liars are retired, everyone is thawed, and the
// machine must finish a frame within a bounded time (the liveness property of design §6.10).
import type { NodeProfile, VirtualNode } from "./node.ts";
import type { VirtualObserver } from "./observer.ts";
import type { Timer, WorldApi } from "./types.ts";

export interface Scenario {
  long: boolean;
  maxNodes: number;
  initialNodes: number;
  stepMinMs: number;
  stepMaxMs: number;
  /** Frames to complete before the calm phase. */
  frames: number;
  /** The chaos phase lasts at least this long and at most the limit, whatever the frame count. */
  chaosMinMs: number;
  chaosLimitMs: number;
  liars: number;
  redundancy: "random" | "always" | "never";
  maxObservers: number;
}

export interface ScenarioOverrides {
  liar?: boolean | null;
  redundancy?: "random" | "always" | "never";
  frames?: number;
  maxNodes?: number;
}

export function scenarioFor(
  seed: number,
  long: boolean,
  random: () => number,
  overrides: ScenarioOverrides = {},
): Scenario {
  const liarByChance = random() < (long ? 0.35 : 0.25);
  const liars = overrides.liar === true ? 1 : overrides.liar === false ? 0 : liarByChance ? 1 : 0;
  return {
    long,
    maxNodes: overrides.maxNodes ?? (long ? 24 : 8),
    initialNodes: 2 + Math.floor(random() * (long ? 4 : 3)),
    stepMinMs: long ? 100 : 200,
    stepMaxMs: long ? 900 : 1_200,
    frames: overrides.frames ?? (long ? 3 : 2),
    chaosMinMs: long ? 5 * 60_000 : 90_000,
    chaosLimitMs: long ? 20 * 60_000 : 8 * 60_000,
    liars: long && liars > 0 && seed % 3 === 0 ? 2 : liars,
    redundancy: overrides.redundancy ?? "random",
    maxObservers: long ? 6 : 3,
  };
}

/** What the generator needs from the world beyond the client API. */
export interface ChaosWorld extends WorldApi {
  readonly nodes: VirtualNode[];
  readonly observers: VirtualObserver[];
  spawnNode(profile: NodeProfile): VirtualNode;
  spawnObserver(): VirtualObserver;
  /** MicroVM ids of the cloud cores serving right now (design §6.8). */
  liveCores(): string[];
  /** Destroy a cloud core's MicroVM: the fleet must notice and replace it. */
  killCore(microvmId: string): void;
  runningExecution(): string | null;
  queuedExecutions(): string[];
  doneExecutions(): string[];
  redundancyOn(): boolean;
}

type Action =
  | "join"
  | "leave"
  | "crash"
  | "freeze"
  | "thaw"
  | "hide"
  | "show"
  | "rejoin"
  | "observerJoin"
  | "observerLeave"
  | "observerCrash"
  | "control"
  | "killCore"
  | "idle";

const WEIGHTS: Array<[Action, number]> = [
  ["join", 14],
  ["leave", 6],
  ["crash", 6],
  ["freeze", 4],
  ["thaw", 5],
  ["hide", 3],
  ["show", 3],
  ["rejoin", 6],
  ["observerJoin", 4],
  ["observerLeave", 3],
  ["observerCrash", 1],
  ["control", 12],
  ["killCore", 2],
  ["idle", 6],
];

type ControlKind =
  | "setRedundancy"
  | "killHalf"
  | "freezeHalf"
  | "throttleHalf"
  | "resumeAll"
  | "restart"
  | "skip"
  | "launch"
  | "killExecution"
  | "runFollowUp";

const CONTROL_WEIGHTS: Array<[ControlKind, number]> = [
  ["setRedundancy", 3],
  ["killHalf", 1],
  ["freezeHalf", 1],
  ["throttleHalf", 1],
  ["resumeAll", 2],
  ["restart", 1],
  ["skip", 1],
  ["launch", 1.5],
  ["killExecution", 0.5],
  ["runFollowUp", 0.5],
];

export class Chaos {
  readonly scenario: Scenario;
  stopped = false;
  private readonly world: ChaosWorld;
  private timer: Timer | null = null;
  private created = 0;
  private liarsCreated = 0;

  constructor(world: ChaosWorld, scenario: Scenario) {
    this.world = world;
    this.scenario = scenario;
  }

  start(): void {
    for (let i = 0; i < this.scenario.initialNodes; i++) {
      const node = this.spawn();
      this.world.after(this.world.between(0, 800), () => node.join());
    }
    const observer = this.world.spawnObserver();
    this.world.after(50, () => {
      observer.join();
      if (this.scenario.redundancy === "always")
        this.world.after(300, () => observer.control({ t: "setRedundancy", on: true }));
    });
    this.scheduleStep();
  }

  /** The chaos ends: retire liars, thaw everyone, make sure the machine can finish a frame. */
  calm(): void {
    this.stopped = true;
    if (this.timer) this.world.cancel(this.timer);
    this.timer = null;
    for (const node of this.world.nodes) {
      if (node.profile.liar) {
        node.retire();
        continue;
      }
      node.thaw();
      node.show();
    }
    let live = this.world.nodes.filter((n) => !n.retired && (n.connected || n.autoRejoin)).length;
    for (const node of this.world.nodes) {
      if (live >= 2) break;
      if (node.retired || node.connected || node.profile.liar || node.profile.fleet === true)
        continue;
      node.rejoin();
      live += 1;
    }
    while (live < 2) {
      this.spawn(false).join();
      live += 1;
    }
    let observer = this.world.observers.find((o) => o.connected);
    if (!observer) {
      observer = this.world.spawnObserver();
      observer.join();
    }
    const chosen = observer;
    this.world.after(500, () => {
      chosen.control({ t: "resumeAll" });
    });
  }

  private spawn(mayLie = true): VirtualNode {
    this.created += 1;
    const r = this.world.random();
    const speed =
      r < 0.7
        ? 0.8 + this.world.random() * 0.5
        : r < 0.9
          ? 1.5 + this.world.random()
          : 3 + this.world.random() * 2;
    const liar = mayLie && this.liarsCreated < this.scenario.liars && this.created >= 2;
    if (liar) this.liarsCreated += 1;
    return this.world.spawnNode({
      hostId: `h${this.created}`,
      kind: this.world.random() < 0.8 ? "tab" : "core",
      speed: Math.round(speed * 100) / 100,
      liar,
    });
  }

  private scheduleStep(): void {
    this.timer = this.world.after(
      this.world.between(this.scenario.stepMinMs, this.scenario.stepMaxMs),
      () => {
        this.timer = null;
        if (this.stopped) return;
        this.act();
        this.scheduleStep();
      },
    );
  }

  private pick<T>(weights: Array<[T, number]>): T {
    const total = weights.reduce((sum, [, w]) => sum + w, 0);
    let r = this.world.random() * total;
    for (const [item, w] of weights) {
      r -= w;
      if (r < 0) return item;
    }
    return (weights[weights.length - 1] as [T, number])[0];
  }

  private one<T>(items: T[]): T | null {
    if (items.length === 0) return null;
    return items[Math.floor(this.world.random() * items.length)] ?? null;
  }

  private act(): void {
    const nodes = this.world.nodes;
    // Cloud cores answer to the fleet, not to a person closing a tab: the generator may destroy
    // their MicroVMs (`killCore`) but never closes or freezes them from the client side (§6.8).
    const churnable = nodes.filter((n) => n.profile.fleet !== true);
    const connected = churnable.filter((n) => n.connected);
    const parked = churnable.filter((n) => !n.connected && !n.retired && !n.frozen);
    switch (this.pick(WEIGHTS)) {
      case "join":
        if (connected.length < this.scenario.maxNodes) this.spawn().join();
        return;
      case "leave":
        this.one(connected)?.leave();
        return;
      case "crash":
        this.one(connected)?.crash();
        return;
      case "freeze":
        this.one(connected.filter((n) => !n.frozen))?.freezeSelf();
        return;
      case "thaw":
        this.one(nodes.filter((n) => n.frozen))?.thaw();
        return;
      case "hide":
        this.one(connected.filter((n) => !n.hidden))?.hide();
        return;
      case "show":
        this.one(nodes.filter((n) => n.hidden))?.show();
        return;
      case "rejoin":
        if (connected.length < this.scenario.maxNodes) this.one(parked)?.rejoin();
        return;
      case "observerJoin": {
        const live = this.world.observers.filter((o) => o.connected);
        if (live.length >= this.scenario.maxObservers) return;
        const idle = this.world.observers.find((o) => !o.connected);
        (idle ?? this.world.spawnObserver()).join();
        return;
      }
      case "observerLeave":
        this.one(this.world.observers.filter((o) => o.connected))?.leave();
        return;
      case "observerCrash":
        this.one(this.world.observers.filter((o) => o.connected))?.crash();
        return;
      case "control":
        this.control();
        return;
      case "killCore": {
        const victim = this.one(this.world.liveCores());
        if (victim) this.world.killCore(victim);
        return;
      }
      case "idle":
        return;
    }
  }

  /** Frames must get a chance to finish: one frame-ending control per observer per 45 s. */
  private mayCancel(observer: VirtualObserver): boolean {
    if (this.world.now - observer.lastCancelAt < 45_000) return false;
    observer.lastCancelAt = this.world.now;
    return true;
  }

  private control(): void {
    const observer = this.one(this.world.observers.filter((o) => o.subscribed));
    if (!observer) return;
    const running = this.world.runningExecution();
    switch (this.pick(CONTROL_WEIGHTS)) {
      case "setRedundancy": {
        if (this.scenario.redundancy === "always") {
          if (!this.world.redundancyOn()) observer.control({ t: "setRedundancy", on: true });
          return;
        }
        if (this.scenario.redundancy === "never") return;
        observer.control({ t: "setRedundancy", on: !this.world.redundancyOn() });
        return;
      }
      case "killHalf":
        observer.control({ t: "killHalf" });
        return;
      case "freezeHalf":
        observer.control({ t: "freezeHalf" });
        return;
      case "throttleHalf":
        observer.control({ t: "throttleHalf" });
        return;
      case "resumeAll":
        observer.control({ t: "resumeAll" });
        return;
      case "restart":
        if (running && this.mayCancel(observer)) observer.control({ t: "restart" });
        return;
      case "skip":
        if (running && this.mayCancel(observer)) observer.control({ t: "skip" });
        return;
      case "launch": {
        // One launch a minute per observer (design §8.4).
        if (this.world.now - observer.lastLaunchAt < 60_000) return;
        if (this.world.queuedExecutions().length >= 2) return;
        if (
          observer.control({
            t: "launch",
            bundle: this.world.bundle,
            params: this.world.program.manifest.defaultParams,
            inherit: this.world.random() < 0.5 ? "latest" : null,
          })
        )
          observer.lastLaunchAt = this.world.now;
        return;
      }
      case "killExecution": {
        const target = this.one([...this.world.queuedExecutions(), ...(running ? [running] : [])]);
        if (target && this.mayCancel(observer))
          observer.control({ t: "killExecution", executionId: target });
        return;
      }
      case "runFollowUp": {
        const done = this.one(this.world.doneExecutions());
        if (done) observer.control({ t: "runFollowUp", executionId: done });
        return;
      }
    }
  }
}
