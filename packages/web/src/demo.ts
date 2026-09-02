// `?demo=1`: a scripted control plane inside the page. It feeds the reducer the same messages the
// wire carries (snapshot, executions, stages, task events, controls, a rotation) and serves real
// Mandelbrot tiles from an in-memory store under their true hashes, so the dashboard's fetch and
// re-hash path runs unchanged. Nothing here touches the network. Used for screenshots and for
// looking at the dashboard without a cluster.
//
// The machine cycles through three programs: a Mandelbrot frame (the story of dashboard v1: a
// straggler, a liar, a scrambled tile, kill half, a rotation), a word count (three stages, a
// `bars` result, a filesystem to browse, logs on the tasks), and a broken program whose planner
// traps (the failure banner), after which the machine goes to sleep and wakes for the next frame
// (the sleep banner). `?program=<name>` starts the cycle there; `?hold=1` pauses after the first
// execution ends.
import type {
  ControlPlaneToObserver,
  Counters,
  ExecutionView,
  FsManifest,
  NodeView,
  PlaceView,
  ProgramView,
  Snapshot,
  TaskView,
} from "@tabframe/protocol";
import { canonicalStringify, encodeBars, PROTOCOL_VERSION } from "@tabframe/protocol";
import { sha256Hex } from "@tabframe/store/hash";
import type { ControlRequest } from "./observer.ts";

export const DEMO_CANVAS = { w: 2048, h: 1280 } as const;
export const DEMO_TILE = 64;
const COLS = DEMO_CANVAS.w / DEMO_TILE;
const ROWS = DEMO_CANVAS.h / DEMO_TILE;
export const DEMO_TASKS = COLS * ROWS;
const SLOTS = 2;
const PROGRAM = "9c2f0d6b1e4a7c3f5d8b2a6e0c4f1d7b3a9e5c8f2b6d0a4e8c1f3b7d5a9e2c6f";
const WORDCOUNT = "4d3b2a1908f7e6d5c4b3a2918070f6e5d4c3b2a1908f7e6d5c4b3a2918070f6e";
const BROKEN = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";
/** The tile (in completion order) served under its true hash with the wrong bytes. */
export const DEMO_SCRAMBLED_AT = 150;
/** Why the demo machine sleeps after the broken program: the core's own wording (design §6.8). */
export const DEMO_SLEEP_REASON = "an hour without anyone touching the dashboard";
/** The programs the demo machine offers, in cycle order. */
export const DEMO_CYCLE = ["mandelbrot", "wordcount", "mandelbrot", "broken"] as const;
export type DemoProgram = (typeof DEMO_CYCLE)[number];

export const DEMO_PROGRAMS: ProgramView[] = [
  {
    bundle: PROGRAM,
    name: "mandelbrot",
    view: "tiles",
    description:
      "640 tiles of 64×64 per 2048×1280 frame, smooth coloring, presets advance every frame.",
    defaultParams: { preset: 0, palette: "ocean" },
    addedAt: 0,
  },
  {
    bundle: WORDCOUNT,
    name: "wordcount",
    view: "bars",
    description: "Map, reduce, merge over /in/corpus.txt; the last task emits the global top-K.",
    defaultParams: { k: 25, mapTasks: 8 },
    addedAt: 0,
  },
  {
    bundle: BROKEN,
    name: "broken",
    view: "text",
    description: "A planner that traps on its first call, so the machine can show a failure.",
    defaultParams: {},
    addedAt: 0,
  },
];

/** Moby-Dick's top words, as the real word count reports them. */
const TOP_WORDS: Array<[string, number]> = [
  ["the", 14529],
  ["of", 6620],
  ["and", 6446],
  ["a", 4736],
  ["to", 4625],
  ["in", 4172],
  ["that", 3085],
  ["his", 2530],
  ["it", 2522],
  ["i", 2127],
  ["he", 1896],
  ["but", 1818],
  ["as", 1741],
  ["is", 1725],
  ["with", 1722],
  ["was", 1644],
  ["for", 1642],
  ["all", 1526],
  ["this", 1440],
  ["at", 1336],
  ["whale", 1240],
  ["by", 1229],
  ["not", 1168],
  ["from", 1104],
  ["so", 1067],
];

export interface DemoClock {
  now(): number;
  set(ms: number): void;
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

interface Preset {
  cx: number;
  cy: number;
  scale: number;
  hue: number;
}
const PRESETS: Preset[] = [
  { cx: -0.7453, cy: 0.1127, scale: 0.0065, hue: 0.55 },
  { cx: -0.1011, cy: 0.9563, scale: 0.03, hue: 0.05 },
  { cx: -1.25066, cy: 0.02012, scale: 0.0018, hue: 0.32 },
  { cx: 0.2825, cy: -0.0111, scale: 0.02, hue: 0.8 },
];

type Event = Exclude<
  Extract<ControlPlaneToObserver, { seq: number }>,
  { t: "snapshot" } | { t: "pong" }
>;
/** An event without its envelope (distributive over the union). */
type Bare = Event extends infer E
  ? E extends Event
    ? Omit<E, "v" | "gen" | "seq">
    : never
  : never;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smoothly colored Mandelbrot tile at the preset, 64×64 RGBA. */
export function renderTile(tx: number, ty: number, preset: Preset): Uint8Array {
  const out = new Uint8Array(DEMO_TILE * DEMO_TILE * 4);
  const maxIter = 160;
  const aspect = DEMO_CANVAS.h / DEMO_CANVAS.w;
  let o = 0;
  for (let py = 0; py < DEMO_TILE; py++) {
    const y0 = preset.cy + ((ty * DEMO_TILE + py) / DEMO_CANVAS.h - 0.5) * preset.scale * aspect;
    for (let px = 0; px < DEMO_TILE; px++) {
      const x0 = preset.cx + ((tx * DEMO_TILE + px) / DEMO_CANVAS.w - 0.5) * preset.scale;
      let x = 0;
      let y = 0;
      let i = 0;
      let x2 = 0;
      let y2 = 0;
      while (x2 + y2 <= 256 && i < maxIter) {
        y = 2 * x * y + y0;
        x = x2 - y2 + x0;
        x2 = x * x;
        y2 = y * y;
        i++;
      }
      if (i >= maxIter) {
        out[o++] = 4;
        out[o++] = 6;
        out[o++] = 10;
        out[o++] = 255;
        continue;
      }
      const smooth = i + 1 - Math.log(Math.log(Math.sqrt(x2 + y2))) / Math.LN2;
      const t = Math.sqrt(smooth / maxIter);
      out[o++] = Math.round(255 * (0.5 + 0.5 * Math.cos(6.2832 * (t + preset.hue))));
      out[o++] = Math.round(255 * (0.5 + 0.5 * Math.cos(6.2832 * (t + preset.hue + 0.33))));
      out[o++] = Math.round(255 * (0.5 + 0.5 * Math.cos(6.2832 * (t + preset.hue + 0.67))));
      out[o++] = 255;
    }
  }
  return out;
}

interface DemoNode extends NodeView {
  frozen: boolean;
  /** Duration factor: cores are faster, throttled tabs slower. */
  pace: number;
}

interface DemoTask extends TaskView {
  /** The attempt each holder is running, so a stale completion timer is ignored. */
  running: Map<string, number>;
}

/** Centre-out order, like the real program's planner. */
export function centreOut(): number[] {
  const idx = Array.from({ length: DEMO_TASKS }, (_, i) => i);
  const cx = (COLS - 1) / 2;
  const cy = (ROWS - 1) / 2;
  const d = (i: number) => {
    const x = i % COLS;
    const y = Math.floor(i / COLS);
    return (x - cx) ** 2 + (y - cy) ** 2;
  };
  idx.sort((a, b) => d(a) - d(b) || a - b);
  return idx;
}

const utf8 = new TextEncoder();

/** The word count's staged outputs: partition counts as text, then the top-K as a bars payload. */
function wordcountStage(stage: number, index: number, count: number): Uint8Array {
  if (stage === 2) return encodeBars(TOP_WORDS.map(([label, value]) => ({ label, value })));
  const words = TOP_WORDS.filter((_, i) => i % count === index);
  const lines = words.map(([w, n]) => `${w} ${stage === 0 ? Math.round(n / 8) : n}`);
  return utf8.encode(`${lines.join("\n")}\n`);
}

const CORPUS_HEAD =
  "Call me Ishmael. Some years ago—never mind how long precisely—having little or no money in my purse, and nothing particular to interest me on shore, I thought I would sail about a little and see the watery part of the world.\n";

export function startDemo(opts: DemoOptions): DemoHandle {
  const speed = opts.speed ?? 1;
  const pauseAtDone = opts.pauseAtDone ?? 0;
  const clock: DemoClock = opts.clock ?? { now: () => Date.now(), set: () => {} };
  const rng = mulberry32(7);
  let seq = 1200;
  let gen = 7;
  let vnow = clock.now();
  let paused = false;
  let timers = new Set<ReturnType<typeof setTimeout>>();
  let frame = 0;
  let executionCounter = 40;
  let taskCounter = 3000;
  let redundancy = false;
  let asleep = false;
  let done = 0;
  let execution: ExecutionView | null = null;
  let program: DemoProgram = "mandelbrot";
  let cycleAt = Math.max(0, DEMO_CYCLE.indexOf(opts.startWith ?? "mandelbrot"));
  let executionsEnded = 0;
  let tasks: DemoTask[] = [];
  let pending: number[] = [];
  /** The filesystem as the stages fold it, for the word count's roots. */
  let files: FsManifest["files"] = {};
  const tally = { reassigned: 0, speculated: 0, verified: 0, mismatched: 0 };
  const nodes = new Map<string, DemoNode>();
  const beats = new Set<number>();

  const emit = (msg: Bare): void => {
    seq += 1;
    opts.apply({ ...msg, v: PROTOCOL_VERSION, gen, seq } as ControlPlaneToObserver);
  };

  const after = (ms: number, fn: () => void): void => {
    if (paused) return;
    const at = vnow + ms;
    const handle = setTimeout(
      () => {
        timers.delete(handle);
        if (paused) return;
        vnow = Math.max(vnow, at);
        clock.set(vnow);
        fn();
      },
      Math.max(0, ms / speed),
    );
    timers.add(handle);
  };

  /** Put bytes in the store under their true hash; the dashboard fetches and re-hashes them. */
  const put = async (bytes: Uint8Array): Promise<string> => {
    const hash = await sha256Hex(bytes);
    opts.store.set(hash, bytes);
    return hash;
  };

  const node = (
    nodeId: string,
    hostId: string,
    kind: "tab" | "core",
    joinedAt: number,
  ): DemoNode => ({
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
  });

  const inFlightOf = (nodeId: string): number => {
    let c = 0;
    for (const t of tasks) if (t.running.has(nodeId)) c++;
    return c;
  };
  const view = (n: DemoNode): NodeView => {
    const { frozen: _frozen, pace: _pace, ...rest } = n;
    return { ...rest, inFlight: inFlightOf(n.nodeId) };
  };
  const taskView = (t: DemoTask): TaskView => {
    const { running: _running, ...rest } = t;
    return { ...rest, holders: [...t.running.keys()] };
  };

  const counters = (): Counters => {
    const c: Counters = { pending: 0, assigned: 0, done: 0, failed: 0, ...tally };
    for (const t of tasks) c[t.status] += 1;
    return c;
  };

  const snapshot = (): void => {
    const rows = tasks.map(taskView);
    const pages = Math.max(1, Math.ceil(rows.length / 256));
    for (let page = 0; page < pages; page++) {
      const base: Snapshot = {
        t: "snapshot",
        v: PROTOCOL_VERSION,
        gen,
        seq,
        page,
        pages,
        tasks: rows.slice(page * 256, (page + 1) * 256),
        at: vnow,
      };
      opts.apply(
        page === 0
          ? {
              ...base,
              nodes: [...nodes.values()].map(view),
              programs: DEMO_PROGRAMS.map((p) => ({ ...p, addedAt: vnow - 41 * 60_000 })),
              execution: execution ? { ...execution, counters: counters() } : null,
              queue: [
                {
                  executionId: "e39",
                  programName: "wordcount",
                  human: true,
                  queuedAt: vnow - 9_000,
                },
              ],
              machine: {
                awake: !asleep,
                reason: asleep ? DEMO_SLEEP_REASON : null,
                redundancy,
                nextRotationAt: vnow + 19 * 60_000,
                uptimeMs: 41 * 60_000,
              },
            }
          : base,
      );
    }
  };

  const place = (index: number): PlaceView => ({
    x: (index % COLS) * DEMO_TILE,
    y: Math.floor(index / COLS) * DEMO_TILE,
    w: DEMO_TILE,
    h: DEMO_TILE,
  });

  const duration = (n: DemoNode): number =>
    (280 + rng() * 520) * n.pace * (n.health === "throttled" ? 2.5 : n.health === "slow" ? 2 : 1);

  const alive = (): DemoNode[] => [...nodes.values()].filter((n) => n.health !== "gone");
  const preset = (): Preset => PRESETS[frame % PRESETS.length] as Preset;

  // ---- executions ------------------------------------------------------------------------------

  const startNext = (): void => {
    // A machine that went to sleep wakes for the next execution; its snapshot says so.
    if (asleep) {
      asleep = false;
      snapshot();
    }
    program = DEMO_CYCLE[cycleAt % DEMO_CYCLE.length] as DemoProgram;
    cycleAt += 1;
    if (program === "mandelbrot") startFrame();
    else if (program === "wordcount") startWordcount();
    else startBroken();
  };

  /** The planner runs as a task on the first live node, like the real machine's (D6). */
  const plan = (stage: number, onDone: (planId: string) => void): void => {
    const planId = `t${++taskCounter}`;
    const planner = alive()[0];
    if (!planner) return;
    after(200, () =>
      emit({ t: "taskAssigned", taskId: planId, nodeId: planner.nodeId, attempt: 1 }),
    );
    after(700, () => {
      planner.tasksDone += 1;
      emit({
        t: "taskDone",
        taskId: planId,
        nodeId: planner.nodeId,
        output: stage === 0 ? PROGRAM : WORDCOUNT,
        place: null,
        computeMs: 412,
        log: {
          text: `plan(${stage}): ${program === "mandelbrot" ? "640 tiles, centre out" : program === "wordcount" ? ["8 map tasks over the corpus", "8 reduce tasks, one per partition", "done: no follow-up"][stage] : ""}`,
        },
      });
      onDone(planId);
    });
  };

  const stageTasks = (executionId: string, stage: number, count: number, placed: boolean): void => {
    tasks = Array.from({ length: count }, (_, index) => ({
      taskId: `t${++taskCounter}`,
      executionId,
      stage,
      index,
      kind: "run" as const,
      status: "pending" as const,
      holders: [],
      attempts: 0,
      output: null,
      place: placed ? place(index) : null,
      contested: false,
      running: new Map<string, number>(),
    }));
    pending = placed ? centreOut() : tasks.map((t) => t.index);
    done = 0;
  };

  const startFrame = (): void => {
    frame += 1;
    beats.clear();
    tally.reassigned = tally.speculated = tally.verified = tally.mismatched = 0;
    const executionId = `e${++executionCounter}`;
    emit({
      t: "executionQueued",
      entry: { executionId, programName: "mandelbrot", human: false, queuedAt: vnow },
    });
    execution = {
      executionId,
      program: PROGRAM,
      programName: "mandelbrot",
      status: "running",
      human: false,
      view: "tiles",
      params: { preset: frame % PRESETS.length, palette: "ocean" },
      stage: 0,
      stageName: "",
      taskCount: 0,
      canvas: { ...DEMO_CANVAS },
      root: null,
      counters: counters(),
      startedAt: vnow,
    };
    tasks = [];
    files = {};
    after(300, () => {
      if (!execution) return;
      emit({ t: "executionStarted", execution: { ...execution } });
      plan(0, () => {
        if (!execution) return;
        stageTasks(executionId, 0, DEMO_TASKS, true);
        execution = { ...execution, stageName: "render", taskCount: DEMO_TASKS };
        emit({
          t: "stageStarted",
          executionId,
          stage: 0,
          name: "render",
          taskCount: DEMO_TASKS,
          canvas: { ...DEMO_CANVAS },
          tasks: tasks.slice(0, 256).map(taskView),
        });
        fill();
      });
    });
  };

  const WC_STAGES: Array<{ name: string; count: number }> = [
    { name: "map", count: 8 },
    { name: "reduce", count: 8 },
    { name: "merge", count: 1 },
  ];

  const startWordcount = (): void => {
    tally.reassigned = tally.speculated = tally.verified = tally.mismatched = 0;
    const executionId = `e${++executionCounter}`;
    emit({
      t: "executionQueued",
      entry: { executionId, programName: "wordcount", human: true, queuedAt: vnow },
    });
    execution = {
      executionId,
      program: WORDCOUNT,
      programName: "wordcount",
      status: "running",
      human: true,
      view: "bars",
      params: { k: 25, mapTasks: 8 },
      stage: 0,
      stageName: "",
      taskCount: 0,
      canvas: null,
      root: null,
      counters: counters(),
      startedAt: vnow,
    };
    tasks = [];
    // The bundle's own files are the first root (design §5.4).
    void Promise.all([
      put(utf8.encode("\0asm\x01\0\0\0 (demo module bytes)")),
      put(
        utf8.encode(
          JSON.stringify({
            name: "wordcount",
            view: "bars",
            defaultParams: { k: 25, mapTasks: 8 },
          }),
        ),
      ),
      put(utf8.encode(CORPUS_HEAD.repeat(6))),
    ]).then(([module, manifest, corpus]) => {
      files = {
        "/program.wasm": { hash: module, size: 34 },
        "/manifest.json": { hash: manifest, size: 62 },
        "/in/corpus.txt": { hash: corpus, size: CORPUS_HEAD.length * 6 },
      };
      void put(utf8.encode(canonicalStringify({ version: 1, files }))).then((root) => {
        if (!execution || execution.executionId !== executionId) return;
        execution = { ...execution, root };
        after(300, () => {
          if (!execution) return;
          emit({ t: "executionStarted", execution: { ...execution } });
          emit({
            t: "executionWarning",
            executionId,
            code: "expired-root",
            message: "the filesystem inherited from e38 is gone; starting from the bundle",
          });
          wordcountStageAt(executionId, 0);
        });
      });
    });
  };

  const wordcountStageAt = (executionId: string, stage: number): void => {
    plan(stage, () => {
      if (!execution || execution.executionId !== executionId) return;
      const spec = WC_STAGES[stage];
      if (!spec) return;
      stageTasks(executionId, stage, spec.count, false);
      execution = { ...execution, stage, stageName: spec.name, taskCount: spec.count };
      emit({
        t: "stageStarted",
        executionId,
        stage,
        name: spec.name,
        taskCount: spec.count,
        canvas: null,
        tasks: tasks.map(taskView),
      });
      fill();
    });
  };

  const startBroken = (): void => {
    const executionId = `e${++executionCounter}`;
    emit({
      t: "executionQueued",
      entry: { executionId, programName: "broken", human: true, queuedAt: vnow },
    });
    execution = {
      executionId,
      program: BROKEN,
      programName: "broken",
      status: "running",
      human: true,
      view: "text",
      params: {},
      stage: 0,
      stageName: "",
      taskCount: 0,
      canvas: null,
      root: BROKEN,
      counters: counters(),
      startedAt: vnow,
    };
    tasks = [];
    after(300, () => {
      if (!execution) return;
      emit({ t: "executionStarted", execution: { ...execution } });
      const planId = `t${++taskCounter}`;
      const planner = alive()[0];
      if (!planner) return;
      after(200, () =>
        emit({ t: "taskAssigned", taskId: planId, nodeId: planner.nodeId, attempt: 1 }),
      );
      after(900, () => {
        const reason = "trap: unreachable (assembly/index.ts:12:3)";
        emit({ t: "taskFailed", taskId: planId, reason });
        emit({ t: "executionFailed", executionId, reason: `task ${planId} failed: ${reason}` });
        execution = null;
        // Nothing runs and nobody has touched the dashboard for an hour: the machine sleeps until
        // the next execution wakes it (design §6.8).
        asleep = true;
        emit({ t: "machineSleeping", reason: DEMO_SLEEP_REASON });
        ended();
      });
    });
  };

  /** An execution ended one way or the other: hold if asked, else the next program after a beat. */
  const ended = (): void => {
    executionsEnded += 1;
    if (opts.holdAfterFirst && executionsEnded === 1) {
      pause();
      return;
    }
    after(2_500, startNext);
  };

  // ---- tasks -----------------------------------------------------------------------------------

  const assign = (task: DemoTask, n: DemoNode, speculative: boolean): void => {
    task.attempts += 1;
    const attempt = task.attempts;
    task.running.set(n.nodeId, attempt);
    if (task.status === "pending") task.status = "assigned";
    if (speculative) {
      tally.speculated += 1;
      emit({ t: "taskSpeculated", taskId: task.taskId, nodeId: n.nodeId });
    } else emit({ t: "taskAssigned", taskId: task.taskId, nodeId: n.nodeId, attempt });
    after(duration(n), () => complete(task, n, attempt));
  };

  const fill = (): void => {
    for (const n of alive()) {
      if (n.frozen) continue;
      while (inFlightOf(n.nodeId) < SLOTS && pending.length > 0) {
        const index = pending.shift() as number;
        const task = tasks[index] as DemoTask;
        assign(task, n, false);
        if (redundancy) {
          const twin = alive().find(
            (m) => m.nodeId !== n.nodeId && !m.frozen && inFlightOf(m.nodeId) < SLOTS,
          );
          if (twin) assign(task, twin, true);
        }
      }
    }
  };

  const bytesFor = (task: DemoTask, scramble: boolean): Uint8Array => {
    if (program === "wordcount") return wordcountStage(task.stage, task.index, tasks.length);
    const bytes = renderTile(task.index % COLS, Math.floor(task.index / COLS), preset());
    if (scramble) for (let i = 0; i < bytes.length; i += 4) bytes[i] = 255 - (bytes[i] as number);
    return bytes;
  };

  /** A log line per task, so the detail panel has something to show; the merge's goes to the store. */
  const logFor = async (
    task: DemoTask,
    ms: number,
  ): Promise<{ text: string } | { hash: string } | null> => {
    if (program === "wordcount") {
      if (task.stage === 2) {
        return {
          hash: await put(
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
  };

  const complete = (task: DemoTask, n: DemoNode, attempt: number): void => {
    if (task.running.get(n.nodeId) !== attempt) return;
    const bytes = bytesFor(task, false);
    void sha256Hex(bytes).then(async (hash) => {
      if (paused || task.running.get(n.nodeId) !== attempt) return;
      task.running.delete(n.nodeId);
      const ms = Math.round(duration(n));
      n.tasksDone += 1;
      n.lastTaskMs = ms;
      if (task.status === "done") {
        tally.verified += 1;
        emit({ t: "taskVerified", taskId: task.taskId, nodeId: n.nodeId });
        fill();
        return;
      }
      if (task.status !== "assigned") return;
      // One tile per frame is served under the right hash with the wrong bytes: the dashboard
      // must catch that on its own.
      const scramble = program === "mandelbrot" && done === DEMO_SCRAMBLED_AT - 1;
      opts.store.set(hash, scramble ? bytesFor(task, true) : bytes);
      task.status = "done";
      task.output = hash;
      const log = await logFor(task, ms);
      if (paused) return;
      emit({
        t: "taskDone",
        taskId: task.taskId,
        nodeId: n.nodeId,
        output: hash,
        place: task.place,
        computeMs: ms,
        ...(log ? { log } : {}),
      });
      done += 1;
      if (program === "mandelbrot") beat();
      if (pauseAtDone > 0 && done >= pauseAtDone) {
        pause();
        return;
      }
      if (done >= tasks.length) finish();
      else fill();
    });
  };

  const release = (n: DemoNode): void => {
    for (const t of tasks) {
      if (!t.running.has(n.nodeId)) continue;
      t.running.delete(n.nodeId);
      if (t.status === "assigned" && t.running.size === 0) {
        t.status = "pending";
        pending.unshift(t.index);
        tally.reassigned += 1;
      }
      emit({ t: "taskReassigned", taskId: t.taskId, fromNode: n.nodeId });
    }
  };

  const leave = (n: DemoNode, reason: "closed" | "silent"): void => {
    n.health = "gone";
    nodes.delete(n.nodeId);
    emit({ t: "nodeLeft", nodeId: n.nodeId, reason });
    release(n);
  };

  const once = (at: number, fn: () => void): void => {
    if (done === at && !beats.has(at)) {
      beats.add(at);
      fn();
    }
  };

  const soloTaskOn = (nodeId: string): DemoTask | undefined =>
    tasks.find((t) => t.status === "assigned" && t.running.has(nodeId) && t.running.size === 1);

  /** The Mandelbrot story, keyed by tiles done in the frame. */
  const beat = (): void => {
    once(40, () => {
      // A straggler: n3 slows down, its task gets a speculative twin on a core, both agree.
      const n3 = nodes.get("n3");
      const core = nodes.get("core-1");
      const task = n3 && soloTaskOn("n3");
      if (!n3 || !core || !task) return;
      n3.health = "slow";
      emit({ t: "nodeHealth", nodeId: "n3", health: "slow" });
      assign(task, core, true);
    });
    once(90, () => {
      // A lying node: n6's late result disagrees with the twin's; the tile is withdrawn and recomputed.
      const n6 = nodes.get("n6");
      const core = nodes.get("core-2");
      const task = n6 && soloTaskOn("n6");
      if (!n6 || !core || !task) return;
      task.running.set("n6", (task.running.get("n6") as number) + 1000); // detach n6's timer
      assign(task, core, true);
      after(duration(core) + 350, () => {
        if (task.status !== "done" || !task.running.has("n6")) return;
        task.running.clear();
        tally.mismatched += 1;
        n6.tasksDone += 1;
        emit({ t: "taskMismatch", taskId: task.taskId, nodeId: "n6" });
        task.status = "pending";
        task.output = null;
        task.contested = true;
        done -= 1;
        const again = alive().find((m) => m.nodeId !== "n6" && !m.frozen);
        if (again) after(200, () => assign(task, again, false));
      });
    });
    once(200, () => {
      // Someone pressed kill half.
      const victims = ["n2", "core-2", "n6"].filter((id) => nodes.has(id));
      emit({ t: "controlApplied", op: "killHalf", nodeIds: victims });
      after(150, () => {
        for (const id of victims) {
          const n = nodes.get(id);
          if (n) leave(n, "closed");
        }
        fill();
      });
      after(2_200, () => {
        const n7 = node("n7", "e5f6", "tab", vnow);
        nodes.set(n7.nodeId, n7);
        emit({ t: "nodeJoined", node: view(n7) });
        fill();
      });
      after(3_400, () => {
        const c3 = node("core-3", "fleet", "core", vnow);
        nodes.set(c3.nodeId, c3);
        emit({ t: "nodeJoined", node: view(c3) });
        fill();
      });
    });
    once(320, () => {
      if (execution)
        emit({
          t: "budget",
          executionId: execution.executionId,
          computeMsUsed: 320 * 600,
          computeMsCap: 20 * 60_000,
        });
    });
    once(420, () => {
      const n1 = nodes.get("n1");
      if (!n1) return;
      n1.health = "throttled";
      n1.visible = false;
      emit({ t: "nodeHealth", nodeId: "n1", health: "throttled" });
      after(5_000, () => {
        if (nodes.get("n1") !== n1) return;
        n1.health = "fast";
        n1.visible = true;
        emit({ t: "nodeHealth", nodeId: "n1", health: "fast" });
      });
    });
    once(462, () => {
      // Another straggler late in the frame, so a twin is usually in flight around tile 470.
      const n1 = nodes.get("n1");
      const core = nodes.get("core-3") ?? nodes.get("core-1");
      const task = n1 && soloTaskOn("n1");
      if (!n1 || !core || !task) return;
      n1.health = "slow";
      emit({ t: "nodeHealth", nodeId: "n1", health: "slow" });
      assign(task, core, true);
    });
    once(465, () => {
      // A tab closes without a word: its open attempts are taken back at the deadline.
      const n3 = nodes.get("n3");
      if (n3) leave(n3, "silent");
      fill();
    });
    once(520, () => {
      // The hourly rotation: the next control plane's snapshot arrives under a new generation.
      emit({ t: "controlPlaneRotating", next: gen + 1, reconnectAfterMs: 2_400 });
      after(2_400, () => {
        gen += 1;
        snapshot();
      });
    });
  };

  /** The stage's outputs land at /out/<stage>/<index>; the folded manifest is the new root. */
  const fold = async (): Promise<string> => {
    const next: FsManifest["files"] = { ...files };
    for (const t of tasks) {
      if (t.output)
        next[`/out/${t.stage}/${t.index}`] = {
          hash: t.output,
          size: opts.store.get(t.output)?.length ?? 0,
        };
    }
    files = next;
    return put(utf8.encode(canonicalStringify({ version: 1, files: next })));
  };

  const finish = (): void => {
    if (!execution) return;
    const exec = execution;
    void fold().then((root) => {
      if (paused || execution !== exec) return;
      emit({ t: "stageDone", executionId: exec.executionId, stage: exec.stage, root });
      execution = { ...exec, root };
      if (program === "wordcount" && exec.stage < WC_STAGES.length - 1) {
        after(300, () => wordcountStageAt(exec.executionId, exec.stage + 1));
        return;
      }
      after(300, () => {
        if (!execution) return;
        emit({
          t: "executionDone",
          executionId: exec.executionId,
          root,
          followUp:
            program === "mandelbrot"
              ? { preset: (frame + 1) % PRESETS.length, palette: "ocean" }
              : program === "wordcount"
                ? { k: 50, mapTasks: 8 }
                : null,
        });
        ended();
      });
    });
  };

  const pause = (): void => {
    paused = true;
    for (const h of timers) clearTimeout(h);
    timers = new Set();
    opts.onPause?.();
  };

  const resume = (): void => {
    if (!paused) return;
    paused = false;
    // Attempts that were mid-flight get fresh completion timers; the story's timers are gone.
    for (const t of tasks) {
      for (const [nodeId, attempt] of t.running) {
        const n = nodes.get(nodeId);
        if (n) after(duration(n), () => complete(t, n, attempt));
      }
    }
    if (!execution) {
      after(600, startNext);
      return;
    }
    fill();
    if (pending.length === 0 && done >= tasks.length && tasks.length > 0) finish();
  };

  const control = (c: ControlRequest): void => {
    switch (c.t) {
      case "killHalf":
      case "freezeHalf":
      case "throttleHalf": {
        const pool = alive().sort(() => rng() - 0.5);
        const victims = pool.slice(0, Math.ceil(pool.length / 2));
        emit({ t: "controlApplied", op: c.t, nodeIds: victims.map((n) => n.nodeId) });
        after(120, () => {
          for (const n of victims) {
            if (c.t === "killHalf") leave(n, "closed");
            else if (c.t === "freezeHalf") {
              n.frozen = true;
              release(n);
            } else {
              n.health = "throttled";
              emit({ t: "nodeHealth", nodeId: n.nodeId, health: "throttled" });
            }
          }
          fill();
        });
        return;
      }
      case "resumeAll": {
        const woken = alive().filter((n) => n.frozen || n.health === "throttled");
        emit({ t: "controlApplied", op: "resumeAll", nodeIds: woken.map((n) => n.nodeId) });
        for (const n of woken) {
          n.frozen = false;
          if (n.health === "throttled") {
            n.health = "fast";
            emit({ t: "nodeHealth", nodeId: n.nodeId, health: "fast" });
          }
        }
        fill();
        return;
      }
      case "restart":
      case "skip":
      case "killExecution": {
        if (!execution) return;
        const reason =
          c.t === "restart" ? "restarted" : c.t === "skip" ? "skipped" : "cancelled by an operator";
        for (const h of timers) clearTimeout(h);
        timers = new Set();
        for (const t of tasks) t.running.clear();
        emit({ t: "executionFailed", executionId: execution.executionId, reason });
        emit({ t: "controlApplied", op: c.t, nodeIds: [] });
        execution = null;
        if (c.t === "restart") cycleAt = Math.max(0, cycleAt - 1);
        after(600, startNext);
        return;
      }
      case "setRedundancy":
        redundancy = c.on;
        emit({ t: "controlApplied", op: "setRedundancy", nodeIds: [] });
        fill();
        return;
      case "launch": {
        // A launch from the programs panel: queue it, and run it next.
        const p = DEMO_PROGRAMS.find((x) => x.bundle === c.bundle);
        if (!p) {
          opts.apply({
            t: "error",
            v: PROTOCOL_VERSION,
            gen,
            code: "launch-refused",
            message: "unknown program",
          });
          return;
        }
        const at = DEMO_CYCLE.indexOf(p.name as DemoProgram);
        if (at >= 0) cycleAt = at;
        emit({
          t: "executionQueued",
          entry: {
            executionId: `e${executionCounter + 1}`,
            programName: p.name,
            human: true,
            queuedAt: vnow,
          },
        });
        if (!execution) after(400, startNext);
        return;
      }
      case "runFollowUp":
        opts.apply({
          t: "error",
          v: PROTOCOL_VERSION,
          gen,
          code: "demo",
          message: `${c.t} is not part of the demo`,
        });
        return;
    }
  };

  for (const n of [
    node("n1", "a1b2", "tab", vnow - 300_000),
    node("n2", "a1b2", "tab", vnow - 299_000),
    node("n3", "c3d4", "tab", vnow - 120_000),
    node("core-1", "fleet", "core", vnow - 2_400_000),
    node("core-2", "fleet", "core", vnow - 2_400_000),
    node("n6", "f00d", "tab", vnow - 45_000),
  ])
    nodes.set(n.nodeId, n);

  snapshot();
  after(400, startNext);

  return {
    control,
    pause,
    resume,
    get paused() {
      return paused;
    },
    get seq() {
      return seq;
    },
    get done() {
      return done;
    },
    get frame() {
      return frame;
    },
  };
}
