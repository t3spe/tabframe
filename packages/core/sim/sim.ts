// The churn simulation (design §12, plan WP1.9): the pure control plane driven on a virtual
// timeline by virtual nodes and observers, with a fake store and the real Mandelbrot program
// running through the sandbox. The process layer here does what packages/control-plane does
// around the core: it delivers effects over sockets with latency, answers fetchBlob, putBlob, and
// presign against the store, and ticks. After every event the invariants of §6.10 and the
// properties below are checked; at the end of every completed frame the accepted outputs are
// compared with the goldens and the stored root manifest with the ledger's files.
import { createHash } from "node:crypto";
import {
  canonicalStringify,
  decodeStageSpec,
  encode,
  encodeStageSpec,
  type FsManifest,
  LIMITS,
  PROTOCOL_VERSION,
  type StageSpec,
  type TaskLimits,
} from "@tabframe/protocol";
import type { BlobPurpose, Effect, Event } from "../src/events.ts";
import { type Harness, harness } from "../src/harness.ts";
import { seededRng } from "../src/interfaces.ts";
import { checkInvariants } from "../src/invariants.ts";
import {
  type ConnRole,
  DEFAULT_TASK_LIMITS,
  type ExecutionRecord,
  type Ledger,
  type TaskRecord,
} from "../src/ledger.ts";
import { stageTasks, wanted } from "../src/scheduler.ts";
import {
  Chaos,
  type ChaosWorld,
  type Scenario,
  type ScenarioOverrides,
  scenarioFor,
} from "./chaos.ts";
import { Timeline } from "./clock.ts";
import { closeName, type NodeProfile, VirtualNode } from "./node.ts";
import { VirtualObserver } from "./observer.ts";
import { computeCacheStats, type LoadedProgram, loadProgram, seedProgram } from "./program.ts";
import { FakeStore } from "./store.ts";
import { type Client, count, emptyStats, type SimStats, type Socket, type Timer } from "./types.ts";

export interface SimOptions extends ScenarioOverrides {
  seed: number;
  long?: boolean;
  /** Keep only the N outermost tiles of every stage (the cheapest); null renders whole frames. */
  tiles?: number | null;
  verbose?: boolean;
  program?: LoadedProgram;
  /** Keep running after the first violation to collect more of them. */
  keepGoing?: boolean;
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
const TILE_BYTES = 64 * 64 * 4;

let sharedProgram: LoadedProgram | null = null;

export function runSim(opts: SimOptions): SimReport {
  if (!opts.program && !sharedProgram) sharedProgram = loadProgram();
  const program = opts.program ?? (sharedProgram as LoadedProgram);
  return new World(opts, program).run();
}

class World implements ChaosWorld {
  readonly program: LoadedProgram;
  readonly store = new FakeStore();
  readonly bundle: string;
  readonly module: string;
  readonly bundleFiles: FsManifest["files"];
  readonly limits: TaskLimits = DEFAULT_TASK_LIMITS;
  readonly stats: SimStats = emptyStats();
  readonly gen: number;
  readonly nodes: VirtualNode[] = [];
  readonly observers: VirtualObserver[] = [];
  readonly violations: string[] = [];
  readonly scenario: Scenario;
  readonly ledger: Ledger;
  private readonly opts: SimOptions;
  private readonly rng: { next(): number };
  private readonly timeline = new Timeline();
  private readonly start: number;
  private readonly h: Harness;
  private readonly chaos: Chaos;
  private readonly sockets = new Map<string, Socket>();
  private connCounter = 0;
  private readonly costs = new Map<string, number>();
  private readonly lies = new Set<string>();
  /** Task index → golden index for the stages the sim trimmed to a subset. */
  private readonly subsets = new Map<string, number[]>();
  private readonly statuses = new Map<string, ExecutionRecord["status"]>();
  private readonly accepted = new Map<string, { identity: string; rounds: number }>();
  private readonly trace = createHash("sha256");
  private readonly verbose: boolean;

  constructor(opts: SimOptions, program: LoadedProgram) {
    this.opts = opts;
    this.program = program;
    this.verbose = opts.verbose === true;
    this.rng = seededRng(opts.seed);
    this.scenario = scenarioFor(opts.seed, opts.long === true, () => this.random(), opts);
    const seeded = seedProgram(this.store, program);
    this.bundle = seeded.bundle;
    this.module = seeded.module;
    this.bundleFiles = seeded.files;
    this.gen = 1 + (opts.seed % 7);
    this.h = harness(
      {
        storeBase: "https://store.sim/blob",
        defaultLoop: { bundle: this.bundle, params: program.manifest.defaultParams },
      },
      this.gen,
      () => this.random(),
    );
    this.ledger = this.h.ledger;
    this.start = this.timeline.now;
    this.chaos = new Chaos(this, this.scenario);
  }

  // --- WorldApi ---

  get now(): number {
    return this.timeline.now;
  }

  random(): number {
    return this.rng.next();
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
    const connId = `c${++this.connCounter}`;
    const sock: Socket = {
      connId,
      role,
      client,
      clientOpen: true,
      cpOpen: true,
      toCpAt: this.now,
      toClientAt: this.now,
    };
    this.sockets.set(connId, sock);
    this.timeline.at(this.arrival(sock, "toCp"), () => {
      if (sock.cpOpen) this.dispatch({ kind: "connected", connId, role });
    });
    return sock;
  }

  send(sock: Socket, msg: Record<string, unknown>): void {
    if (!sock.clientOpen) return;
    const raw = JSON.stringify({ ...msg, v: PROTOCOL_VERSION, gen: this.gen });
    this.stats.messagesToControlPlane += 1;
    this.timeline.at(this.arrival(sock, "toCp"), () => {
      if (sock.cpOpen) this.dispatch({ kind: "message", connId: sock.connId, raw });
    });
  }

  close(sock: Socket): void {
    if (!sock.clientOpen) return;
    sock.clientOpen = false;
    this.timeline.at(this.arrival(sock, "toCp"), () => {
      if (!sock.cpOpen) return;
      sock.cpOpen = false;
      this.dispatch({ kind: "disconnected", connId: sock.connId });
    });
  }

  crash(sock: Socket): void {
    sock.clientOpen = false;
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
    this.lies.add(hash);
  }

  note(text: string): void {
    if (this.verbose) console.log(`${this.stamp()} ${text}`);
  }

  // --- ChaosWorld ---

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

  runningExecution(): string | null {
    return this.ledger.running;
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
    const settleWindow = this.settleWindow();
    let phase: "chaos" | "calm" = "chaos";
    let framesAtCalm = 0;
    let settleAt = 0;
    while (this.timeline.step()) {
      if (this.violations.length > 0 && this.opts.keepGoing !== true) break;
      if (this.stats.events > MAX_EVENTS) {
        this.violation(`more than ${MAX_EVENTS} events`);
        break;
      }
      if (phase === "chaos") {
        if (
          (this.stats.framesDone >= this.scenario.frames && this.now >= chaosMinEndAt) ||
          this.now >= chaosEndAt
        ) {
          phase = "calm";
          framesAtCalm = this.stats.framesDone;
          settleAt = this.now + settleWindow;
          this.note(`calm: ${framesAtCalm} frames done, settle window ${settleWindow} ms`);
          this.chaos.calm();
        }
      } else if (this.stats.framesDone > framesAtCalm) {
        break;
      } else if (this.now > settleAt) {
        this.violation(`stalled: no frame completed within ${settleWindow} ms of calm`);
        break;
      }
    }
    this.finalChecks();
    this.stats.computeMisses = computeCacheStats().misses - missesBefore;
    return {
      seed: this.opts.seed,
      ok: this.violations.length === 0,
      violations: this.violations,
      stats: this.stats,
      scenario: this.scenario,
      virtualMs: this.now - this.start,
      wallMs: Math.round(performance.now() - wall),
      trace: this.trace.digest("hex"),
    };
  }

  /** How long the calm phase may take to finish a frame: generous, so a trip means a real stall. */
  private settleWindow(): number {
    const tasks = this.opts.tiles ?? this.program.goldens?.taskCount ?? 640;
    return 120_000 + Math.ceil((3 * tasks * 3_000) / 4);
  }

  private scheduleTick(): void {
    this.timeline.after(TICK_MS, () => {
      this.dispatch({ kind: "tick" });
      this.scheduleTick();
    });
  }

  private netLatency(): number {
    return this.between(5, 80);
  }

  private storeLatency(): number {
    return this.between(10, 60);
  }

  /** FIFO per direction: the next message arrives after the previous one, plus its own latency. */
  private arrival(sock: Socket, dir: "toCp" | "toClient"): number {
    const key = dir === "toCp" ? "toCpAt" : "toClientAt";
    const at = Math.max(this.now + this.netLatency(), sock[key]);
    sock[key] = at;
    return at;
  }

  private stamp(): string {
    return `+${((this.now - this.start) / 1000).toFixed(3)}s`;
  }

  // --- the process around the core ---

  private dispatch(event: Event): void {
    this.h.advance(this.timeline.now - this.h.now);
    let effects: Effect[];
    try {
      effects = this.h.event(event);
    } catch (err) {
      const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
      this.violation(`apply threw on ${describeEvent(event)}: ${text}`);
      return;
    }
    this.stats.events += 1;
    const line = `${describeEvent(event)} → ${effects.map(describeEffect).join(", ") || "nothing"}`;
    this.trace.update(`${this.now} ${line}\n`);
    if (this.verbose) console.log(`${this.stamp()} [seq ${this.ledger.meta.seq}] ${line}`);
    this.checkProperties(event, effects);
    this.execute(effects);
    this.trackExecutions();
    if (this.ledger.nodes.size > this.stats.peakNodes)
      this.stats.peakNodes = this.ledger.nodes.size;
  }

  private execute(effects: Effect[]): void {
    // A send is checked against the ledger unless the same batch closes that connection later:
    // a sweep may announce one departure to an observer it declares gone a moment after.
    const closing = new Set<string>();
    for (const e of effects) if (e.kind === "close") closing.add(e.connId);
    for (const e of effects) {
      switch (e.kind) {
        case "send":
          this.deliver(e.connId, e.msg, !closing.has(e.connId));
          break;
        case "close": {
          const sock = this.sockets.get(e.connId);
          count(this.stats.closes, closeName(e.code));
          if (!sock) {
            this.violation(`close of unknown connection ${e.connId}`);
            break;
          }
          if (!sock.cpOpen) break;
          sock.cpOpen = false;
          this.timeline.at(this.arrival(sock, "toClient"), () => {
            if (!sock.clientOpen) return;
            sock.clientOpen = false;
            sock.client.onClosed(e.code, e.reason);
          });
          break;
        }
        case "fetchBlob": {
          const { hash, purpose } = e;
          this.timeline.after(this.storeLatency(), () => {
            let bytes = this.store.get(hash);
            if (bytes && purpose.type === "stageSpec") bytes = this.rewriteSpec(bytes, purpose);
            this.dispatch({ kind: "blobFetched", hash, bytes, purpose });
          });
          break;
        }
        case "putBlob": {
          const { bytes, purpose } = e;
          this.timeline.after(this.storeLatency(), () => {
            const hash = this.store.put(bytes);
            this.dispatch({ kind: "blobStored", hash, size: bytes.length, purpose });
          });
          break;
        }
        case "resolveBundle": {
          // Every launch in the simulation names the seeded bundle, so the ledger knows it.
          this.violation(`resolveBundle for ${e.bundle.slice(0, 12)} asked by ${e.connId}`);
          const { bundle, connId } = e;
          this.timeline.after(this.storeLatency(), () =>
            this.dispatch({ kind: "bundleRejected", bundle, connId, reason: "unknown bundle" }),
          );
          break;
        }
        case "presign": {
          const { connId, items } = e;
          this.timeline.after(this.storeLatency(), () => {
            const urls = items.map(({ hash }) => ({
              hash,
              url: this.store.has(hash) ? null : `https://store.sim/put/${hash}`,
              headers: { "x-amz-checksum-sha256": hash },
            }));
            this.deliver(
              connId,
              { t: "presigned", v: PROTOCOL_VERSION, gen: this.gen, urls },
              false,
            );
          });
          break;
        }
      }
    }
  }

  private deliver(
    connId: string,
    msg: { t: string; [key: string]: unknown },
    fromApply: boolean,
  ): void {
    const sock = this.sockets.get(connId);
    if (!sock) {
      this.violation(`send ${msg.t} to unknown connection ${connId}`);
      return;
    }
    if (fromApply && !this.ledger.conns.has(connId))
      this.violation(`send ${msg.t} to forgotten connection ${connId}`);
    if (!sock.cpOpen) return;
    let raw: string;
    try {
      raw = encode(msg);
    } catch (err) {
      this.violation(`${msg.t} to ${connId}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.stats.messagesToClients += 1;
    this.timeline.at(this.arrival(sock, "toClient"), () => {
      if (sock.clientOpen) sock.client.receive(raw);
    });
  }

  /**
   * The store hands the planner's spec back to the core; the sim may trim it to the outermost
   * tiles (`tiles`) and pins a `done` follow-up to this frame's params, so every frame is one the
   * goldens cover and the compute cache already holds.
   */
  private rewriteSpec(bytes: Uint8Array, purpose: BlobPurpose): Uint8Array {
    if (purpose.type !== "stageSpec") return bytes;
    let spec: StageSpec;
    try {
      spec = decodeStageSpec(bytes);
    } catch {
      return bytes;
    }
    const stage = this.ledger.tasks.get(purpose.taskId)?.stage ?? 0;
    if (spec.kind === "stage") {
      const n = this.opts.tiles ?? null;
      if (n === null || n >= spec.tasks.length) return bytes;
      const first = spec.tasks.length - n;
      const kept = spec.tasks.slice(first);
      this.subsets.set(
        `${purpose.executionId}:${stage}`,
        kept.map((_, i) => first + i),
      );
      return encodeStageSpec({ ...spec, tasks: kept });
    }
    if (!spec.next) return bytes;
    const exec = this.ledger.executions.get(purpose.executionId);
    const preset = exec?.params.preset;
    return encodeStageSpec({
      kind: "done",
      next: { ...spec.next, preset: typeof preset === "number" ? preset : 0 },
    });
  }

  // --- properties checked after every event ---

  private tasksOf(executionId: string): TaskRecord[] {
    const out: TaskRecord[] = [];
    for (const t of this.ledger.tasks.values()) if (t.executionId === executionId) out.push(t);
    return out;
  }

  private goldenFor(task: TaskRecord): string | null {
    const goldens = this.program.goldens;
    if (!goldens || task.kind !== "run" || task.stage !== 0) return null;
    const map = this.subsets.get(`${task.executionId}:0`);
    const index = map ? map[task.index] : task.index;
    if (index === undefined) return null;
    return goldens.hashes[index] ?? null;
  }

  private checkProperties(event: Event, effects: Effect[]): void {
    const ledger = this.ledger;
    for (const v of checkInvariants(ledger)) this.violation(`invariant: ${v}`);

    // Finality (§6.10): an accepted result changes only through a mismatch.
    if (ledger.running) {
      for (const t of this.tasksOf(ledger.running)) {
        const prev = this.accepted.get(t.taskId);
        if (t.accepted) {
          if (prev && prev.identity !== t.accepted.identity && prev.rounds === t.contestedRounds)
            this.violation(`task ${t.taskId}: accepted result replaced without a mismatch`);
          this.accepted.set(t.taskId, { identity: t.accepted.identity, rounds: t.contestedRounds });
        } else if (prev) {
          if (prev.rounds === t.contestedRounds)
            this.violation(`task ${t.taskId}: accepted result withdrawn without a mismatch`);
          this.accepted.delete(t.taskId);
        }
      }
    }

    // Slots (§8.4) and ownership: two tasks per node at most, all of the running execution.
    for (const n of ledger.nodes.values()) {
      if (n.inFlight.length > LIMITS.maxInFlight)
        this.violation(`node ${n.nodeId} holds ${n.inFlight.length} tasks`);
      for (const id of n.inFlight) {
        const t = ledger.tasks.get(id);
        if (t && t.executionId !== ledger.running)
          this.violation(`node ${n.nodeId} holds ${id} of ${t.executionId}, which is not running`);
      }
    }

    // Liveness (§6.4): a tick leaves nothing silent beyond the gone window.
    if (event.kind === "tick") {
      for (const n of ledger.nodes.values()) {
        if (this.now - n.lastSeen > LIMITS.goneAfterMs)
          this.violation(`node ${n.nodeId} silent for ${this.now - n.lastSeen} ms survived a tick`);
      }
    }

    const painted = new Set<string>();
    for (const e of effects) {
      if (e.kind !== "send") continue;
      if (e.msg.t === "assign") this.checkAssign(e.connId, e.msg.taskId, e.msg.attempt);
      else if (e.msg.t === "taskDone" && !painted.has(e.msg.taskId)) {
        painted.add(e.msg.taskId);
        this.checkPainted(e.msg.taskId, e.msg.output);
      }
    }
  }

  /** An assignment: to the right socket, of the running execution, in tier order (§6.3). */
  private checkAssign(connId: string, taskId: string, attemptNo: number): void {
    const ledger = this.ledger;
    const task = ledger.tasks.get(taskId);
    const attempt = task?.attempts.find((a) => a.attempt === attemptNo);
    if (!task || !attempt) {
      this.violation(`assign of unknown ${taskId}@${attemptNo}`);
      return;
    }
    const node = ledger.nodes.get(attempt.nodeId);
    if (!node || node.connId !== connId)
      this.violation(`assign ${taskId} went to ${connId}, its attempt is on ${attempt.nodeId}`);
    if (task.executionId !== ledger.running)
      this.violation(`assign ${taskId} of ${task.executionId}, which is not running`);
    if (attempt.speculative) {
      const other = task.attempts.find((a) => a !== attempt && a.outcome === "running");
      if (!other) this.violation(`speculative twin of ${taskId} without a running first attempt`);
      else if (other.deadlineAt > this.now)
        this.violation(
          `speculative twin of ${taskId} opened ${other.deadlineAt - this.now} ms before the deadline`,
        );
      return;
    }
    if (task.released) return;
    // Released work outranks fresh work: nothing released that this node could take may wait.
    const exec = ledger.executions.get(task.executionId);
    if (!exec) return;
    for (const t of stageTasks(ledger, exec)) {
      if (t === task || !t.released || wanted(t) === 0) continue;
      if (t.attempts.some((a) => a.outcome === "running" && a.nodeId === attempt.nodeId)) continue;
      // A node that already reported on a contested task may leave it to nodes that have not.
      if (t.results.some((r) => r.nodeId === attempt.nodeId)) continue;
      this.violation(
        `fresh ${taskId} assigned to ${attempt.nodeId} while released ${t.taskId} waited`,
      );
      return;
    }
  }

  /** A painted tile is golden unless a liar painted it; liars are judged at the end of the frame. */
  private checkPainted(taskId: string, output: string): void {
    const task = this.ledger.tasks.get(taskId);
    if (!task) return;
    const golden = this.goldenFor(task);
    if (golden === null || output === golden || this.lies.has(output)) return;
    this.violation(
      `task ${taskId} painted ${output.slice(0, 12)}, the golden is ${golden.slice(0, 12)}`,
    );
  }

  private trackExecutions(): void {
    for (const exec of this.ledger.executions.values()) {
      const prev = this.statuses.get(exec.executionId);
      if (prev === exec.status) continue;
      this.statuses.set(exec.executionId, exec.status);
      switch (exec.status) {
        case "done":
          this.stats.framesDone += 1;
          this.note(`${exec.executionId} done`);
          this.checkFrame(exec);
          this.absorbCounters(exec);
          break;
        case "failed":
          this.stats.framesFailed += 1;
          count(this.stats.failures, exec.failure ?? "unknown");
          this.violation(`execution ${exec.executionId} failed: ${exec.failure}`);
          this.absorbCounters(exec);
          break;
        case "cancelled":
          this.stats.framesCancelled += 1;
          count(this.stats.failures, exec.failure ?? "cancelled");
          this.absorbCounters(exec);
          break;
        default:
          break;
      }
    }
  }

  /** A finished frame: every stage-0 output golden (or a voted-in lie), in the store, in the root. */
  private checkFrame(exec: ExecutionRecord): void {
    const id = exec.executionId;
    const goldens = this.program.goldens;
    const tasks = this.tasksOf(id)
      .filter((t) => t.kind === "run" && t.stage === 0)
      .sort((a, b) => a.index - b.index);
    const map = this.subsets.get(`${id}:0`);
    const expected = map ? map.length : (goldens?.taskCount ?? tasks.length);
    if (tasks.length !== expected)
      this.violation(`${id}: ${tasks.length} stage-0 tasks, expected ${expected}`);
    for (const t of tasks) {
      if (t.status !== "done" || !t.accepted) {
        this.violation(`${id} is done while ${t.taskId} is ${t.status}`);
        continue;
      }
      const out = t.accepted;
      const golden = this.goldenFor(t);
      if (golden !== null && out.output !== golden) {
        if (!this.lies.has(out.output)) {
          this.violation(
            `${t.taskId}: accepted ${out.output.slice(0, 12)}, golden ${golden.slice(0, 12)}`,
          );
        } else {
          this.stats.liesAccepted += 1;
          if (t.requiredAgreement === 2 && !this.agreementExplains(t, golden))
            this.violation(
              `${t.taskId}: a lie accepted under redundancy without two nodes behind it (${describeResults(t, golden)})`,
            );
        }
      }
      if (out.outputSize !== TILE_BYTES)
        this.violation(`${t.taskId}: output size ${out.outputSize}`);
      if (!this.store.has(out.output))
        this.violation(`${t.taskId}: accepted output not in the store`);
      const entry = exec.files[`/out/0/${t.index}`];
      if (!entry || entry.hash !== out.output || entry.size !== out.outputSize)
        this.violation(`${t.taskId}: the manifest entry differs from the accepted result`);
    }
    if (!exec.root) {
      this.violation(`${id} done without a root`);
      return;
    }
    const bytes = this.store.get(exec.root);
    if (!bytes) {
      this.violation(`${id}: root ${exec.root.slice(0, 12)} is not in the store`);
      return;
    }
    const stored = JSON.parse(new TextDecoder().decode(bytes)) as FsManifest;
    const expectedManifest: FsManifest = { version: 1, files: exec.files };
    if (canonicalStringify(stored) !== canonicalStringify(expectedManifest))
      this.violation(`${id}: the stored root manifest differs from the ledger's files`);
  }

  /**
   * What the toggle promises (D7), counted the way the core counts it: a lie is accepted only when
   * two node ids reported it, or when a vote by node ids favoured it. A liar that reconnects is a
   * new node (D11) and may agree with its former self; that is the documented limit, not a bug.
   */
  private agreementExplains(task: TaskRecord, golden: string): boolean {
    const wrong = new Set<string>();
    const right = new Set<string>();
    for (const r of task.results) {
      if (r.identity === task.accepted?.identity) wrong.add(r.nodeId);
      else if (r.output === golden) right.add(r.nodeId);
    }
    return task.resolvedByVote ? wrong.size >= right.size : wrong.size >= 2;
  }

  /** Ended executions are pruned from the ledger after a while, so their counters are taken now. */
  private absorbCounters(exec: ExecutionRecord): void {
    this.stats.done += exec.counters.done;
    this.stats.reassigned += exec.counters.reassigned;
    this.stats.speculated += exec.counters.speculated;
    this.stats.verified += exec.counters.verified;
    this.stats.mismatched += exec.counters.mismatched;
    for (const t of this.tasksOf(exec.executionId)) this.stats.assigned += t.attempts.length;
  }

  private finalChecks(): void {
    for (const v of checkInvariants(this.ledger)) this.violation(`final invariant: ${v}`);
    for (const e of this.ledger.executions.values()) {
      if (e.status === "running" || e.status === "queued") this.absorbCounters(e);
    }
    if (this.scenario.liars === 0 && this.stats.mismatched > 0)
      this.violation(`${this.stats.mismatched} mismatches without a liar around`);
  }
}

/** The message type, plus the task and attempt of a result, straight from the frame text. */
/** The reports of a task, for a violation message: node, round, and whether it was the golden. */
function describeResults(task: TaskRecord, golden: string): string {
  const reports = task.results
    .map((r) => `${r.nodeId}@r${r.round}:${r.output === golden ? "golden" : r.output.slice(0, 6)}`)
    .join(" ");
  return `rounds ${task.contestedRounds}, vote ${task.resolvedByVote}, accepted ${task.accepted?.output.slice(0, 6) ?? "-"}, reports ${reports}`;
}

const typeOf = (raw: unknown): string => {
  if (typeof raw !== "string") return "?";
  const t = /"t":"([A-Za-z]+)"/.exec(raw)?.[1] ?? "?";
  if (t !== "result") return t;
  const task = /"taskId":"([^"]+)"/.exec(raw)?.[1] ?? "?";
  const attempt = /"attempt":(\d+)/.exec(raw)?.[1] ?? "?";
  const error = raw.includes('"error":') ? " error" : "";
  return `result ${task}@${attempt}${error}`;
};

function describeEvent(event: Event): string {
  switch (event.kind) {
    case "connected":
      return `connected ${event.connId} ${event.role}`;
    case "message":
      return `message ${event.connId} ${typeOf(event.raw)}`;
    case "disconnected":
      return `disconnected ${event.connId}`;
    case "tick":
      return "tick";
    case "blobFetched":
      return `blobFetched ${event.purpose.type} ${event.hash.slice(0, 8)} ${event.bytes ? event.bytes.length : "missing"}`;
    case "blobStored":
      return `blobStored ${event.purpose.type} ${event.hash.slice(0, 8)}`;
    case "programAdded":
      return `programAdded ${event.manifest.name}`;
    case "launch":
      return `launch ${event.human ? "human" : "auto"}`;
    case "bundleRejected":
      return `bundleRejected ${event.bundle.slice(0, 8)} ${event.reason}`;
  }
}

function describeEffect(e: Effect): string {
  switch (e.kind) {
    case "send":
      if (e.msg.t === "assign")
        return `send ${e.connId} assign ${e.msg.taskId}@${e.msg.attempt} ${e.msg.kind}`;
      if (e.msg.t === "cancel") return `send ${e.connId} cancel ${e.msg.taskId}`;
      if (e.msg.t === "command") return `send ${e.connId} command ${e.msg.op}`;
      return `send ${e.connId} ${e.msg.t}`;
    case "close":
      return `close ${e.connId} ${closeName(e.code)}`;
    case "fetchBlob":
      return `fetchBlob ${e.purpose.type} ${e.hash.slice(0, 8)}`;
    case "putBlob":
      return `putBlob ${e.purpose.type} ${e.bytes.length}`;
    case "presign":
      return `presign ${e.connId} ${e.items.length}`;
    case "resolveBundle":
      return `resolveBundle ${e.connId} ${e.bundle.slice(0, 8)}`;
  }
}
