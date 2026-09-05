// The demo's control plane: nodes, tasks, the tally, the in-page store, and the events they emit
// as the same messages the wire carries. Time comes from an injected scheduler, so a test drives a
// frame in milliseconds; the story (the beats, which program runs next) is a separate module.
import type {
  ControlPlaneToObserver,
  Counters,
  ExecutionView,
  FsManifest,
  NodeView,
  PlaceView,
  Snapshot,
  TaskView,
} from "@tabframe/protocol";
import { canonicalStringify, PROTOCOL_VERSION } from "@tabframe/protocol";
import { sha256Hex } from "@tabframe/store/hash";
import type { ControlRequest } from "../controls.ts";
import {
  COLS,
  centreOut,
  DEMO_CYCLE,
  DEMO_PROGRAMS,
  DEMO_SCRAMBLED_AT,
  DEMO_SLEEP_REASON,
  DEMO_TILE,
  type DemoProgram,
  mulberry32,
  PRESETS,
  PROGRAM,
  type Preset,
  renderTile,
  SLOTS,
  utf8,
  WC_STAGES,
  WORDCOUNT,
  wordcountStage,
} from "./content.ts";

export interface DemoClock {
  now(): number;
  set(ms: number): void;
}

/** Real timers on the page; a test passes a manual scheduler. */
export interface DemoTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DemoOptions {
  apply(msg: ControlPlaneToObserver): void;
  /** hash → bytes; the page's blob source reads from it. */
  store: Map<string, Uint8Array>;
  /** 1 is real time. */
  speed?: number;
  /** Pause (and stop the clock) once this many tasks of an execution are done; 0 never pauses. */
  pauseAtDone?: number;
  onPause?(): void;
  /** Virtual clock the page renders with; advanced by the script so flashes freeze on pause. */
  clock?: DemoClock;
  /** Start the cycle at this program instead of the first Mandelbrot frame. */
  startWith?: DemoProgram;
  /** Pause once the first execution has ended (done or failed), so its result stays on screen. */
  holdAfterFirst?: boolean;
  timers?: DemoTimers;
}

export interface DemoHandle {
  control(c: ControlRequest): void;
  pause(): void;
  resume(): void;
  readonly paused: boolean;
  readonly seq: number;
  readonly done: number;
  readonly frame: number;
}

export interface DemoNode extends NodeView {
  frozen: boolean;
  /** Duration factor: cores are faster, throttled tabs slower. */
  pace: number;
}

export interface DemoTask extends TaskView {
  /** The attempt each holder is running, so a stale completion timer is ignored. */
  running: Map<string, number>;
}

type Event = Exclude<
  Extract<ControlPlaneToObserver, { seq: number }>,
  { t: "snapshot" } | { t: "pong" }
>;
/** An event without its envelope (distributive over the union). */
export type Bare = Event extends infer E
  ? E extends Event
    ? Omit<E, "v" | "gen" | "seq">
    : never
  : never;

/** What the machine calls back into the story for. */
export interface Story {
  /** A tile of the Mandelbrot frame landed. */
  beat(): void;
  /** An execution ended one way or the other. */
  ended(): void;
  /** Start the next program of the cycle; `force` ignores a Stop. */
  startNext(force?: boolean): void;
  /** A multi-stage program's stage folded; plan the next one. */
  nextStage(executionId: string, stage: number): void;
}

const realTimers: DemoTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class DemoMachine {
  readonly opts: DemoOptions;
  readonly speed: number;
  readonly pauseAtDone: number;
  readonly clock: DemoClock;
  readonly timers: DemoTimers;
  readonly rng = mulberry32(7);
  story: Story = {
    beat: () => {},
    ended: () => {},
    startNext: () => {},
    nextStage: () => {},
  };
  seq = 1200;
  gen = 7;
  vnow: number;
  paused = false;
  /** Stop and the editor's pause, as the demo answers them: the header reflects a click. */
  stopped = false;
  launchedByPerson = false;
  pausedByEditor = false;
  private timerHandles = new Set<unknown>();
  frame = 0;
  executionCounter = 40;
  taskCounter = 3000;
  redundancy = false;
  asleep = false;
  done = 0;
  execution: ExecutionView | null = null;
  program: DemoProgram = "mandelbrot";
  cycleAt: number;
  tasks: DemoTask[] = [];
  pending: number[] = [];
  /** The filesystem as the stages fold it, for the word count's roots. */
  files: FsManifest["files"] = {};
  readonly tally = { reassigned: 0, speculated: 0, verified: 0, mismatched: 0 };
  readonly nodes = new Map<string, DemoNode>();

  constructor(opts: DemoOptions) {
    this.opts = opts;
    this.speed = opts.speed ?? 1;
    this.pauseAtDone = opts.pauseAtDone ?? 0;
    this.clock = opts.clock ?? { now: () => Date.now(), set: () => {} };
    this.timers = opts.timers ?? realTimers;
    this.vnow = this.clock.now();
    this.cycleAt = Math.max(0, DEMO_CYCLE.indexOf(opts.startWith ?? "mandelbrot"));
  }

  emit(msg: Bare): void {
    this.seq += 1;
    this.opts.apply({
      ...msg,
      v: PROTOCOL_VERSION,
      gen: this.gen,
      seq: this.seq,
    } as ControlPlaneToObserver);
  }

  /** Run `fn` after `ms` of the demo's time; nothing while paused, and a pause cancels it. */
  after(ms: number, fn: () => void): void {
    if (this.paused) return;
    const at = this.vnow + ms;
    const handle = this.timers.setTimeout(
      () => {
        this.timerHandles.delete(handle);
        if (this.paused) return;
        this.vnow = Math.max(this.vnow, at);
        this.clock.set(this.vnow);
        fn();
      },
      Math.max(0, ms / this.speed),
    );
    this.timerHandles.add(handle);
  }

  private cancelTimers(): void {
    for (const h of this.timerHandles) this.timers.clearTimeout(h);
    this.timerHandles = new Set();
  }

  /** A rejection in a fire-and-forget chain reaches the page as an error line instead of a silent stall. */
  fault(err: unknown): void {
    this.opts.apply({
      t: "error",
      v: PROTOCOL_VERSION,
      gen: this.gen,
      code: "demo",
      message: `the demo script failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  /** Put bytes in the store under their true hash; the dashboard fetches and re-hashes them. */
  async put(bytes: Uint8Array): Promise<string> {
    const hash = await sha256Hex(bytes);
    this.opts.store.set(hash, bytes);
    return hash;
  }

  node(nodeId: string, hostId: string, kind: "tab" | "core", joinedAt: number): DemoNode {
    return {
      nodeId,
      hostId,
      kind,
      health: "fast",
      visible: true,
      tasksDone: 0,
      lastTaskMs: null,
      inFlight: 0,
      joinedAt,
      frozen: false,
      pace: kind === "core" ? 0.6 : 1,
    };
  }

  inFlightOf(nodeId: string): number {
    let c = 0;
    for (const t of this.tasks) if (t.running.has(nodeId)) c++;
    return c;
  }

  view(n: DemoNode): NodeView {
    const { frozen: _frozen, pace: _pace, ...rest } = n;
    return { ...rest, inFlight: this.inFlightOf(n.nodeId) };
  }

  taskView(t: DemoTask): TaskView {
    const { running: _running, ...rest } = t;
    return { ...rest, holders: [...t.running.keys()] };
  }

  counters(): Counters {
    const c: Counters = { pending: 0, assigned: 0, done: 0, failed: 0, ...this.tally };
    for (const t of this.tasks) c[t.status] += 1;
    return c;
  }

  snapshot(): void {
    const rows = this.tasks.map((t) => this.taskView(t));
    const pages = Math.max(1, Math.ceil(rows.length / 256));
    for (let page = 0; page < pages; page++) {
      const base: Snapshot = {
        t: "snapshot",
        v: PROTOCOL_VERSION,
        gen: this.gen,
        seq: this.seq,
        page,
        pages,
        tasks: rows.slice(page * 256, (page + 1) * 256),
        at: this.vnow,
      };
      this.opts.apply(
        page === 0
          ? {
              ...base,
              nodes: [...this.nodes.values()].map((n) => this.view(n)),
              programs: DEMO_PROGRAMS.map((p) => ({ ...p, addedAt: this.vnow - 41 * 60_000 })),
              execution: this.execution ? { ...this.execution, counters: this.counters() } : null,
              queue: [
                {
                  executionId: "e39",
                  programName: "wordcount",
                  human: true,
                  queuedAt: this.vnow - 9_000,
                },
              ],
              machine: {
                awake: !this.asleep,
                reason: this.asleep ? DEMO_SLEEP_REASON : null,
                redundancy: this.redundancy,
                stopped: this.stopped,
                paused: this.pausedByEditor,
                yielded: false,
                nextRotationAt: this.vnow + 19 * 60_000,
                uptimeMs: 41 * 60_000,
              },
            }
          : base,
      );
    }
  }

  place(index: number): PlaceView {
    return {
      x: (index % COLS) * DEMO_TILE,
      y: Math.floor(index / COLS) * DEMO_TILE,
      w: DEMO_TILE,
      h: DEMO_TILE,
    };
  }

  duration(n: DemoNode): number {
    return (
      (280 + this.rng() * 520) *
      n.pace *
      (n.health === "throttled" ? 2.5 : n.health === "slow" ? 2 : 1)
    );
  }

  alive(): DemoNode[] {
    return [...this.nodes.values()].filter((n) => n.health !== "gone");
  }

  preset(): Preset {
    return PRESETS[this.frame % PRESETS.length] as Preset;
  }

  /** The planner runs as a task on the first live node, like the real machine's (D6). */
  plan(stage: number, onDone: (planId: string) => void): void {
    const planId = `t${++this.taskCounter}`;
    const planner = this.alive()[0];
    if (!planner) return;
    this.after(200, () =>
      this.emit({ t: "taskAssigned", taskId: planId, nodeId: planner.nodeId, attempt: 1 }),
    );
    this.after(700, () => {
      planner.tasksDone += 1;
      this.emit({
        t: "taskDone",
        taskId: planId,
        nodeId: planner.nodeId,
        output: stage === 0 ? PROGRAM : WORDCOUNT,
        place: null,
        computeMs: 412,
        log: {
          text: `plan(${stage}): ${this.program === "mandelbrot" ? "640 tiles, centre out" : this.program === "wordcount" ? ["8 map tasks over the corpus", "8 reduce tasks, one per partition", "done: no follow-up"][stage] : ""}`,
        },
      });
      onDone(planId);
    });
  }

  /** Fresh tasks for a stage: placed on the frame in centre-out order, or unplaced in index order. */
  stageTasks(executionId: string, stage: number, count: number, placed: boolean): void {
    this.tasks = Array.from({ length: count }, (_, index) => ({
      taskId: `t${++this.taskCounter}`,
      executionId,
      stage,
      index,
      kind: "run" as const,
      status: "pending" as const,
      holders: [],
      attempts: 0,
      output: null,
      place: placed ? this.place(index) : null,
      contested: false,
      running: new Map<string, number>(),
    }));
    this.pending = placed ? centreOut() : this.tasks.map((t) => t.index);
    this.done = 0;
  }

  assign(task: DemoTask, n: DemoNode, speculative: boolean): void {
    task.attempts += 1;
    const attempt = task.attempts;
    task.running.set(n.nodeId, attempt);
    if (task.status === "pending") task.status = "assigned";
    if (speculative) {
      this.tally.speculated += 1;
      this.emit({ t: "taskSpeculated", taskId: task.taskId, nodeId: n.nodeId });
    } else this.emit({ t: "taskAssigned", taskId: task.taskId, nodeId: n.nodeId, attempt });
    this.after(this.duration(n), () => this.complete(task, n, attempt));
  }

  /** Hand pending tasks to every live, unfrozen node with a free slot; a twin too under redundancy. */
  fill(): void {
    for (const n of this.alive()) {
      if (n.frozen) continue;
      while (this.inFlightOf(n.nodeId) < SLOTS && this.pending.length > 0) {
        const index = this.pending.shift() as number;
        const task = this.tasks[index] as DemoTask;
        this.assign(task, n, false);
        if (this.redundancy) {
          const twin = this.alive().find(
            (m) => m.nodeId !== n.nodeId && !m.frozen && this.inFlightOf(m.nodeId) < SLOTS,
          );
          if (twin) this.assign(task, twin, true);
        }
      }
    }
  }

  bytesFor(task: DemoTask, scramble: boolean): Uint8Array {
    if (this.program === "wordcount")
      return wordcountStage(task.stage, task.index, this.tasks.length);
    const bytes = renderTile(task.index % COLS, Math.floor(task.index / COLS), this.preset());
    if (scramble) for (let i = 0; i < bytes.length; i += 4) bytes[i] = 255 - (bytes[i] as number);
    return bytes;
  }

  /** A log line per task, so the detail panel has something to show; the merge's goes to the store. */
  async logFor(task: DemoTask, ms: number): Promise<{ text: string } | { hash: string } | null> {
    if (this.program === "wordcount") {
      if (task.stage === 2) {
        return {
          hash: await this.put(
            utf8.encode(`merge: read 8 partitions\ntop-25 of 17358 distinct words\n${ms} ms\n`),
          ),
        };
      }
      return {
        text:
          task.stage === 0
            ? `map ${task.index}: bytes ${task.index * 152_541}..${(task.index + 1) * 152_541} → 8 partitions`
            : `reduce ${task.index}: merged 8 inputs for partition ${task.index}`,
      };
    }
    return task.index % 50 === 0 ? { text: `tile ${task.index}: ${ms} ms` } : null;
  }

  /** An attempt's timer fired: the result lands under its hash, unless the attempt was taken back. */
  complete(task: DemoTask, n: DemoNode, attempt: number): void {
    if (task.running.get(n.nodeId) !== attempt) return;
    const bytes = this.bytesFor(task, false);
    sha256Hex(bytes)
      .then(async (hash) => {
        if (this.paused || task.running.get(n.nodeId) !== attempt) return;
        task.running.delete(n.nodeId);
        const ms = Math.round(this.duration(n));
        n.tasksDone += 1;
        n.lastTaskMs = ms;
        if (task.status === "done") {
          this.tally.verified += 1;
          this.emit({ t: "taskVerified", taskId: task.taskId, nodeId: n.nodeId });
          this.fill();
          return;
        }
        if (task.status !== "assigned") return;
        // One tile per frame is served under the right hash with the wrong bytes: the dashboard
        // must catch that on its own.
        const scramble = this.program === "mandelbrot" && this.done === DEMO_SCRAMBLED_AT - 1;
        this.opts.store.set(hash, scramble ? this.bytesFor(task, true) : bytes);
        task.status = "done";
        task.output = hash;
        const log = await this.logFor(task, ms);
        if (this.paused) return;
        this.emit({
          t: "taskDone",
          taskId: task.taskId,
          nodeId: n.nodeId,
          output: hash,
          place: task.place,
          computeMs: ms,
          ...(log ? { log } : {}),
        });
        this.done += 1;
        if (this.program === "mandelbrot") this.story.beat();
        if (this.pauseAtDone > 0 && this.done >= this.pauseAtDone) {
          this.pause();
          return;
        }
        if (this.done >= this.tasks.length) this.finish();
        else this.fill();
      })
      .catch((err) => this.fault(err));
  }

  /** Take back everything a node holds; a task nobody else runs goes back to the front of the queue. */
  release(n: DemoNode): void {
    for (const t of this.tasks) {
      if (!t.running.has(n.nodeId)) continue;
      t.running.delete(n.nodeId);
      if (t.status === "assigned" && t.running.size === 0) {
        t.status = "pending";
        this.pending.unshift(t.index);
        this.tally.reassigned += 1;
      }
      this.emit({ t: "taskReassigned", taskId: t.taskId, fromNode: n.nodeId });
    }
  }

  leave(n: DemoNode, reason: "closed" | "silent"): void {
    n.health = "gone";
    this.nodes.delete(n.nodeId);
    this.emit({ t: "nodeLeft", nodeId: n.nodeId, reason });
    this.release(n);
  }

  /** A task only this node is running, for a straggler or a liar to hold. */
  soloTaskOn(nodeId: string): DemoTask | undefined {
    return this.tasks.find(
      (t) => t.status === "assigned" && t.running.has(nodeId) && t.running.size === 1,
    );
  }

  /** The stage's outputs land at /out/<stage>/<index>; the folded manifest is the new root. */
  async fold(): Promise<string> {
    const next: FsManifest["files"] = { ...this.files };
    for (const t of this.tasks) {
      if (t.output)
        next[`/out/${t.stage}/${t.index}`] = {
          hash: t.output,
          size: this.opts.store.get(t.output)?.length ?? 0,
        };
    }
    this.files = next;
    return this.put(utf8.encode(canonicalStringify({ version: 1, files: next })));
  }

  /** The stage's last task landed: fold, then the next stage or the end of the execution. */
  finish(): void {
    if (!this.execution) return;
    const exec = this.execution;
    this.fold()
      .then((root) => {
        if (this.paused || this.execution !== exec) return;
        this.emit({ t: "stageDone", executionId: exec.executionId, stage: exec.stage, root });
        this.execution = { ...exec, root };
        if (this.program === "wordcount" && exec.stage < WC_STAGES.length - 1) {
          this.after(300, () => this.story.nextStage(exec.executionId, exec.stage + 1));
          return;
        }
        this.after(300, () => {
          if (!this.execution) return;
          this.emit({
            t: "executionDone",
            executionId: exec.executionId,
            root,
            followUp:
              this.program === "mandelbrot"
                ? { preset: (this.frame + 1) % PRESETS.length, palette: "ocean" }
                : this.program === "wordcount"
                  ? { k: 50, mapTasks: 8 }
                  : null,
          });
          this.story.ended();
        });
      })
      .catch((err) => this.fault(err));
  }

  pause(): void {
    this.paused = true;
    this.cancelTimers();
    this.opts.onPause?.();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    // Attempts that were mid-flight get fresh completion timers; the story's timers are gone.
    for (const t of this.tasks) {
      for (const [nodeId, attempt] of t.running) {
        const n = this.nodes.get(nodeId);
        if (n) this.after(this.duration(n), () => this.complete(t, n, attempt));
      }
    }
    if (!this.execution) {
      this.after(600, () => this.story.startNext());
      return;
    }
    this.fill();
    if (this.pending.length === 0 && this.done >= this.tasks.length && this.tasks.length > 0)
      this.finish();
  }

  /** End the running execution the way a control does: every timer and attempt dropped. */
  private endExecution(reason: string): void {
    if (!this.execution) return;
    this.cancelTimers();
    for (const t of this.tasks) t.running.clear();
    this.emit({ t: "executionFailed", executionId: this.execution.executionId, reason });
    this.execution = null;
  }

  control(c: ControlRequest): void {
    switch (c.t) {
      case "killHalf":
      case "freezeHalf":
      case "throttleHalf": {
        const pool = this.alive().sort(() => this.rng() - 0.5);
        const victims = pool.slice(0, Math.ceil(pool.length / 2));
        this.emit({ t: "controlApplied", op: c.t, nodeIds: victims.map((n) => n.nodeId) });
        this.after(120, () => {
          for (const n of victims) {
            if (c.t === "killHalf") this.leave(n, "closed");
            else if (c.t === "freezeHalf") {
              n.frozen = true;
              this.release(n);
            } else {
              n.health = "throttled";
              this.emit({ t: "nodeHealth", nodeId: n.nodeId, health: "throttled" });
            }
          }
          this.fill();
        });
        return;
      }
      case "resumeAll": {
        const woken = this.alive().filter((n) => n.frozen || n.health === "throttled");
        this.emit({ t: "controlApplied", op: "resumeAll", nodeIds: woken.map((n) => n.nodeId) });
        for (const n of woken) {
          n.frozen = false;
          if (n.health === "throttled") {
            n.health = "fast";
            this.emit({ t: "nodeHealth", nodeId: n.nodeId, health: "fast" });
          }
        }
        this.fill();
        return;
      }
      case "restart":
      case "skip":
      case "killExecution": {
        if (!this.execution) return;
        this.endExecution(
          c.t === "restart" ? "restarted" : c.t === "skip" ? "skipped" : "cancelled by an operator",
        );
        this.emit({ t: "controlApplied", op: c.t, nodeIds: [] });
        if (c.t === "restart") this.cycleAt = Math.max(0, this.cycleAt - 1);
        this.after(600, () => this.story.startNext());
        return;
      }
      case "setRedundancy":
        this.redundancy = c.on;
        this.emit({ t: "controlApplied", op: "setRedundancy", nodeIds: [] });
        this.fill();
        return;
      case "stop": {
        // Stop ends what runs and holds the loop until Start, in the demo as on the machine.
        this.stopped = true;
        this.endExecution("stopped by a person");
        this.emit({ t: "controlApplied", op: "stop", nodeIds: [] });
        return;
      }
      case "start":
        this.stopped = false;
        this.emit({ t: "controlApplied", op: "start", nodeIds: [] });
        this.launchedByPerson = true;
        if (!this.execution) this.after(400, () => this.story.startNext(true));
        return;
      case "pause":
        this.pausedByEditor = true;
        this.emit({ t: "controlApplied", op: "pause", nodeIds: [] });
        return;
      case "resume":
        this.pausedByEditor = false;
        this.emit({ t: "controlApplied", op: "resume", nodeIds: [] });
        return;
      case "launch": {
        // A launch from the programs panel: queue it, and run it next.
        const p = DEMO_PROGRAMS.find((x) => x.bundle === c.bundle);
        if (!p) {
          this.opts.apply({
            t: "error",
            v: PROTOCOL_VERSION,
            gen: this.gen,
            code: "launch-refused",
            message: "unknown program",
          });
          return;
        }
        const at = DEMO_CYCLE.indexOf(p.name as DemoProgram);
        if (at >= 0) this.cycleAt = at;
        this.emit({
          t: "executionQueued",
          entry: {
            executionId: `e${this.executionCounter + 1}`,
            programName: p.name,
            human: true,
            queuedAt: this.vnow,
          },
        });
        if (!this.execution) this.after(400, () => this.story.startNext());
        return;
      }
      case "runFollowUp":
        this.opts.apply({
          t: "error",
          v: PROTOCOL_VERSION,
          gen: this.gen,
          code: "demo",
          message: `${c.t} is not part of the demo`,
        });
        return;
    }
  }

  /** The six nodes the demo starts with, the first snapshot, and the first execution shortly after. */
  boot(): void {
    const t = this.vnow;
    for (const n of [
      this.node("n1", "a1b2", "tab", t - 300_000),
      this.node("n2", "a1b2", "tab", t - 299_000),
      this.node("n3", "c3d4", "tab", t - 120_000),
      this.node("core-1", "fleet", "core", t - 2_400_000),
      this.node("core-2", "fleet", "core", t - 2_400_000),
      this.node("n6", "f00d", "tab", t - 45_000),
    ])
      this.nodes.set(n.nodeId, n);
    this.snapshot();
    this.after(400, () => this.story.startNext());
  }

  handle(): DemoHandle {
    const machine = this;
    return {
      control: (c) => this.control(c),
      pause: () => this.pause(),
      resume: () => this.resume(),
      get paused() {
        return machine.paused;
      },
      get seq() {
        return machine.seq;
      },
      get done() {
        return machine.done;
      },
      get frame() {
        return machine.frame;
      },
    };
  }
}
