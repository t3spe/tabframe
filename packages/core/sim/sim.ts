// The churn simulation (design §12): the pure control plane driven on a virtual timeline by
// virtual nodes and observers, with a fake store and the real Mandelbrot program running through
// the sandbox. `process.ts` is the process around the core, `properties.ts` the checks, and this
// file the world they share and the phases of a run: chaos, calm, and the optional fleet drill.
import type { FsManifest, TaskLimits } from "@tabframe/protocol";
import type { Effect, Event } from "../src/events.ts";
import { type Harness, harness } from "../src/harness.ts";
import { seededRng } from "../src/interfaces.ts";
import type { ConnRole, ExecutionRecord, Ledger } from "../src/ledger.ts";
import { DEFAULT_TASK_LIMITS, YIELD_IDLE_MS } from "../src/policy.ts";
import { wanted } from "../src/scheduler.ts";
import { stageTasks } from "../src/tasks.ts";
import {
  Chaos,
  type ChaosWorld,
  type Scenario,
  type ScenarioOverrides,
  scenarioFor,
} from "./chaos.ts";
import { Timeline } from "./clock.ts";
import { type DrillWorld, FleetDrill, SimFleet } from "./fleet.ts";
import { type NodeProfile, VirtualNode } from "./node.ts";
import { VirtualObserver } from "./observer.ts";
import { Process, type ProcessHost } from "./process.ts";
import { computeCacheStats, type LoadedProgram, loadProgram, seedProgram } from "./program.ts";
import { Properties, type PropertiesHost } from "./properties.ts";
import { FakeStore } from "./store.ts";
import { type Client, emptyStats, type SimStats, type Socket, type Timer } from "./types.ts";

export interface SimOptions extends ScenarioOverrides {
  seed: number;
  long?: boolean;
  /** Keep only the N outermost tiles of every stage (the cheapest); null renders whole frames. */
  tiles?: number | null;
  verbose?: boolean;
  program?: LoadedProgram;
  /** Keep running after the first violation to collect more of them. */
  keepGoing?: boolean;
  /**
   * After the calm frame, run the fleet drill (design §6.8): destroy a cloud core and watch it
   * come back, let everyone leave and watch the machine sleep, then bring a visitor back.
   */
  drill?: boolean;
}

export interface SimReport {
  seed: number;
  ok: boolean;
  violations: string[];
  stats: SimStats;
  scenario: Scenario;
  virtualMs: number;
  wallMs: number;
  /** Hash of every event and its effects: two runs with the same inputs produce the same trace. */
  trace: string;
}

/** The process tick (packages/control-plane's default). */
const TICK_MS = 500;
const MAX_EVENTS = 3_000_000;

let sharedProgram: LoadedProgram | null = null;

export function runSim(opts: SimOptions): SimReport {
  if (!opts.program && !sharedProgram) sharedProgram = loadProgram();
  const program = opts.program ?? (sharedProgram as LoadedProgram);
  return new World(opts, program).run();
}

class World implements ChaosWorld, DrillWorld, ProcessHost, PropertiesHost {
  readonly program: LoadedProgram;
  readonly store = new FakeStore();
  readonly bundle: string;
  readonly module: string;
  readonly bundleFiles: FsManifest["files"];
  readonly limits: TaskLimits = DEFAULT_TASK_LIMITS;
  readonly stats: SimStats = emptyStats();
  readonly nodes: VirtualNode[] = [];
  readonly observers: VirtualObserver[] = [];
  readonly violations: string[] = [];
  readonly scenario: Scenario;
  readonly timeline = new Timeline();
  readonly tiles: number | null;
  private generation: number;
  private readonly opts: SimOptions;
  private readonly rng: () => number;
  private readonly start: number;
  private readonly h: Harness;
  private readonly process: Process;
  private readonly properties: Properties;
  private readonly chaos: Chaos;
  private readonly simFleet: SimFleet;
  private readonly costs = new Map<string, number>();
  private readonly verbose: boolean;

  constructor(opts: SimOptions, program: LoadedProgram) {
    this.opts = opts;
    this.program = program;
    this.verbose = opts.verbose === true;
    this.tiles = opts.tiles ?? null;
    this.rng = seededRng(opts.seed);
    this.scenario = scenarioFor(opts.seed, opts.long === true, () => this.random(), opts);
    const seeded = seedProgram(this.store, program);
    this.bundle = seeded.bundle;
    this.module = seeded.module;
    this.bundleFiles = seeded.files;
    this.generation = 1 + (opts.seed % 7);
    this.h = harness(
      {
        storeBase: "https://store.sim/blob",
        defaultLoop: { bundle: this.bundle, params: program.manifest.defaultParams },
        // A cloud control plane: it has the MicroVM API and keeps a fleet (design §6.8).
        cloudCores: true,
      },
      this.generation,
      () => this.random(),
    );
    this.start = this.timeline.now;
    this.process = new Process(this, this.h);
    this.properties = new Properties(this);
    this.chaos = new Chaos(this, this.scenario);
    this.simFleet = new SimFleet(this);
  }

  // --- WorldApi ---

  get now(): number {
    return this.timeline.now;
  }

  get gen(): number {
    return this.generation;
  }

  get realism(): Scenario {
    return this.scenario;
  }

  get ledger(): Ledger {
    return this.process.ledger;
  }

  get liars(): number {
    return this.scenario.liars;
  }

  random(): number {
    return this.rng();
  }

  between(min: number, max: number): number {
    return min + Math.floor(this.random() * (max - min + 1));
  }

  after(ms: number, run: () => void): Timer {
    return this.timeline.after(ms, run);
  }

  cancel(timer: Timer): void {
    this.timeline.cancel(timer);
  }

  connect(client: Client, role: ConnRole): Socket {
    return this.process.connect(client, role);
  }

  send(sock: Socket, msg: Record<string, unknown>): void {
    this.process.send(sock, msg);
  }

  close(sock: Socket): void {
    this.process.close(sock);
  }

  crash(sock: Socket): void {
    this.process.crash(sock);
  }

  violation(text: string): void {
    this.violations.push(`${this.stamp()} ${text}`);
    if (this.verbose) console.log(`${this.stamp()} VIOLATION ${text}`);
  }

  /**
   * Compute cost on the reference machine. The shape follows the measured Mandelbrot tiles at
   * preset 0 (median under 5 ms, a sixth of the tiles between 0.3 and 1.3 s): most tiles are
   * trivial and a heavy tail sits near the deadline floor, which is what makes speculation and
   * the message rate real concerns.
   */
  taskCost(taskId: string, kind: "run" | "plan"): number {
    const known = this.costs.get(taskId);
    if (known !== undefined) return known;
    let cost: number;
    if (kind === "plan") cost = this.between(5, 40);
    else {
      const r = this.random();
      if (r < 0.72) cost = this.between(2, 10);
      else if (r < 0.79) cost = this.between(10, 60);
      else if (r < 0.85) cost = this.between(60, 300);
      else cost = this.between(300, 1_300);
    }
    this.costs.set(taskId, cost);
    return cost;
  }

  recordLie(hash: string): void {
    this.properties.recordLie(hash);
  }

  note(text: string): void {
    if (this.verbose) console.log(`${this.stamp()} ${text}`);
  }

  // --- ChaosWorld, FleetWorld, DrillWorld ---

  spawnNode(profile: NodeProfile): VirtualNode {
    const node = new VirtualNode(this, `v${this.nodes.length + 1}`, profile);
    this.nodes.push(node);
    return node;
  }

  spawnObserver(): VirtualObserver {
    const observer = new VirtualObserver(this, `o${this.observers.length + 1}`);
    this.observers.push(observer);
    return observer;
  }

  dispatch(event: Event): void {
    this.process.dispatch(event);
  }

  liveCores(): string[] {
    return this.simFleet.liveCores();
  }

  killCore(microvmId: string): void {
    this.simFleet.killMicrovm(microvmId);
  }

  runningExecution(): string | null {
    return this.ledger.running;
  }

  loopState(): { stopped: boolean; yielded: boolean } {
    return { stopped: this.ledger.meta.loopStopped, yielded: this.ledger.meta.loopYielded };
  }

  queuedExecutions(): string[] {
    return [...this.ledger.queue];
  }

  doneExecutions(): string[] {
    const done: string[] = [];
    for (const e of this.ledger.executions.values())
      if (e.status === "done") done.push(e.executionId);
    return done.slice(-4);
  }

  redundancyOn(): boolean {
    return this.ledger.meta.redundancy;
  }

  // --- ProcessHost, PropertiesHost ---

  fleet(): SimFleet {
    return this.simFleet;
  }

  observe(event: Event, effects: Effect[]): void {
    this.properties.afterEvent(event, effects);
  }

  settled(): void {
    this.properties.trackExecutions();
    if (this.ledger.nodes.size > this.stats.peakNodes)
      this.stats.peakNodes = this.ledger.nodes.size;
  }

  rotated(next: number): void {
    this.generation = next;
  }

  subsetFor(executionId: string, stage: number): number[] | undefined {
    return this.process.subsetFor(executionId, stage);
  }

  // --- the run ---

  run(): SimReport {
    const wall = performance.now();
    const missesBefore = computeCacheStats().misses;
    this.dispatch({
      kind: "programAdded",
      bundle: this.bundle,
      module: this.module,
      manifest: this.program.manifest,
      files: this.bundleFiles,
    });
    this.scheduleTick();
    this.chaos.start();
    const chaosEndAt = this.now + this.scenario.chaosLimitMs;
    const chaosMinEndAt = this.now + this.scenario.chaosMinMs;
    const rotateAt =
      this.scenario.rotateAfterMs === null ? null : this.now + this.scenario.rotateAfterMs;
    const settleWindow = this.settleWindow();
    let phase: "chaos" | "calm" | "drill" = "chaos";
    let framesAtCalm = 0;
    let settleAt = 0;
    let settleDeadline = 0;
    let rotated = false;
    let drill: FleetDrill | null = null;
    while (this.timeline.step()) {
      if (this.violations.length > 0 && this.opts.keepGoing !== true) break;
      if (this.stats.events > MAX_EVENTS) {
        this.violation(`more than ${MAX_EVENTS} events`);
        break;
      }
      if (rotateAt !== null && !rotated && this.now >= rotateAt) {
        rotated = true;
        this.process.rotate(this.generation + 1);
      }
      if (phase === "chaos") {
        if (
          (this.stats.framesDone >= this.scenario.frames && this.now >= chaosMinEndAt) ||
          this.now >= chaosEndAt
        ) {
          phase = "calm";
          framesAtCalm = this.stats.framesDone;
          settleAt = this.now + settleWindow;
          settleDeadline = settleAt;
          this.note(`calm: ${framesAtCalm} frames done, settle window ${settleWindow} ms`);
          this.chaos.calm();
        }
      } else if (phase === "calm") {
        if (this.stats.framesDone > framesAtCalm) {
          // The machine works. The fleet drill, when asked for, is the last thing a run does.
          if (this.opts.drill !== true) break;
          phase = "drill";
          drill = new FleetDrill(this, this.simFleet);
          this.note("drill: starting");
        } else {
          // The loop yields to people (design §6.8): after a person's launch ends it launches
          // nothing until Start or ten idle minutes, and the calm phase owes it that wait.
          const m = this.ledger.meta;
          if (m.loopYielded)
            settleDeadline = Math.max(
              settleDeadline,
              m.lastInteractionAt + YIELD_IDLE_MS + settleWindow,
            );
          if (this.now > settleDeadline) {
            this.violation(
              `stalled: no frame completed within ${settleDeadline - settleAt + settleWindow} ms of calm (${this.machineState()})`,
            );
            break;
          }
        }
      } else if (drill) {
        drill.poll();
        if (drill.done) break;
      }
    }
    this.properties.final();
    this.stats.computeMisses = computeCacheStats().misses - missesBefore;
    return {
      seed: this.opts.seed,
      ok: this.violations.length === 0,
      violations: this.violations,
      stats: this.stats,
      scenario: this.scenario,
      virtualMs: this.now - this.start,
      wallMs: Math.round(performance.now() - wall),
      trace: this.process.traceDigest(),
    };
  }

  /** Why the machine is idle, for a stall report: every gate the default loop checks (§6.8). */
  private machineState(): string {
    const l = this.ledger;
    const exec = l.running ? l.executions.get(l.running) : undefined;
    const open = exec
      ? stageTasks(l, exec).filter((t) => t.status === "pending" || t.status === "assigned").length
      : 0;
    const paused = (l.meta.loopPausedUntil ?? 0) - this.now;
    return [
      `running ${l.running ?? "none"}${exec ? ` stage ${exec.stage} ${open} open` : ""}`,
      `queue ${l.queue.length}`,
      `nodes ${l.nodes.size}`,
      `observers ${l.observers.size}`,
      `programs ${l.programs.size}`,
      paused > 0 ? `loop paused ${Math.round(paused)} ms` : "loop ready",
      `stopped ${l.meta.loopStopped} yielded ${l.meta.loopYielded} pausedBy ${l.session.pausedBy ?? "none"} idle ${this.now - l.meta.lastInteractionAt} ms`,
      `executions ${[...l.executions.values()].map((e) => `${e.executionId}${e.human ? "H" : "a"}:${e.status}`).join(" ")}`,
      ...(exec ? this.describeOpen(exec) : []),
    ].join(", ");
  }

  /** The virtual node behind an open attempt: what it thinks it is doing (a stall is usually here). */
  private describeHolder(nodeId: string): string {
    const node = this.nodes.find((n) => n.nodeId === nodeId);
    if (!node) return `${nodeId}:absent`;
    return `${nodeId}/${node.id}:${node.state()}`;
  }

  /** The open tasks of a stalled stage, with everything that decides whether they can be filled. */
  private describeOpen(exec: ExecutionRecord): string[] {
    const out: string[] = [];
    for (const t of stageTasks(this.ledger, exec)) {
      if (t.status !== "pending" && t.status !== "assigned") continue;
      const running = t.attempts.filter((a) => a.outcome === "running");
      const reports = t.results.map((r) => `${r.nodeId}@r${r.round}`).join("/") || "none";
      const holders = running.map((a) => this.describeHolder(a.nodeId)).join(" ") || "none";
      out.push(
        `[${t.taskId} ${t.kind} ${t.status} want ${wanted(t)} need ${t.requiredAgreement} round ${t.contestedRounds} released ${t.released} reports ${reports} holders ${holders}]`,
      );
      if (out.length >= 4) break;
    }
    return out;
  }

  /** How long the calm phase may take to finish a frame: generous, so a trip means a real stall. */
  private settleWindow(): number {
    const tasks = this.tiles ?? this.program.goldens?.taskCount ?? 640;
    return 120_000 + Math.ceil((3 * tasks * 3_000) / 4);
  }

  private scheduleTick(): void {
    this.timeline.after(TICK_MS, () => {
      this.dispatch({ kind: "tick" });
      this.scheduleTick();
    });
  }

  private stamp(): string {
    return `+${((this.now - this.start) / 1000).toFixed(3)}s`;
  }
}
