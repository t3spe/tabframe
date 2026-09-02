// `?demo=1`: a scripted control plane inside the page. It feeds the reducer the same messages the
// wire carries (snapshot, executions, stages, task events, controls, a rotation) and serves real
// Mandelbrot tiles from an in-memory store under their true hashes, so the dashboard's fetch and
// re-hash path runs unchanged. Nothing here touches the network. Used for screenshots and for
// looking at the dashboard without a cluster.
import type {
  ControlPlaneToObserver,
  Counters,
  ExecutionView,
  NodeView,
  PlaceView,
  Snapshot,
  TaskView,
} from "@tabframe/protocol";
import { PROTOCOL_VERSION } from "@tabframe/protocol";
import { sha256Hex } from "@tabframe/store/hash";
import type { ControlRequest } from "./observer.ts";

export const DEMO_CANVAS = { w: 2048, h: 1280 } as const;
export const DEMO_TILE = 64;
const COLS = DEMO_CANVAS.w / DEMO_TILE;
const ROWS = DEMO_CANVAS.h / DEMO_TILE;
export const DEMO_TASKS = COLS * ROWS;
const SLOTS = 2;
const PROGRAM = "9c2f0d6b1e4a7c3f5d8b2a6e0c4f1d7b3a9e5c8f2b6d0a4e8c1f3b7d5a9e2c6f";
/** The tile (in completion order) served under its true hash with the wrong bytes. */
export const DEMO_SCRAMBLED_AT = 150;

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
  /** Pause (and stop the clock) once this many tiles of a frame are done; 0 never pauses. */
  pauseAtDone?: number;
  onPause?(): void;
  /** Virtual clock the page renders with; advanced by the script so flashes freeze on pause. */
  clock?: DemoClock;
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
  let done = 0;
  let execution: ExecutionView | null = null;
  let tasks: DemoTask[] = [];
  let pending: number[] = [];
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
                awake: true,
                reason: null,
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

  const startFrame = (): void => {
    frame += 1;
    done = 0;
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
    after(300, () => {
      if (!execution) return;
      emit({ t: "executionStarted", execution: { ...execution } });
      const planId = `t${++taskCounter}`;
      const planner = alive()[0];
      if (planner) {
        after(200, () =>
          emit({ t: "taskAssigned", taskId: planId, nodeId: planner.nodeId, attempt: 1 }),
        );
        after(700, () =>
          emit({
            t: "taskDone",
            taskId: planId,
            nodeId: planner.nodeId,
            output: PROGRAM,
            place: null,
            computeMs: 412,
          }),
        );
      }
      after(800, () => {
        if (!execution) return;
        tasks = Array.from({ length: DEMO_TASKS }, (_, index) => ({
          taskId: `t${++taskCounter}`,
          executionId,
          stage: 0,
          index,
          kind: "run" as const,
          status: "pending" as const,
          holders: [],
          attempts: 0,
          output: null,
          place: place(index),
          contested: false,
          running: new Map<string, number>(),
        }));
        pending = centreOut();
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
    const bytes = renderTile(task.index % COLS, Math.floor(task.index / COLS), preset());
    if (scramble) for (let i = 0; i < bytes.length; i += 4) bytes[i] = 255 - (bytes[i] as number);
    return bytes;
  };

  const complete = (task: DemoTask, n: DemoNode, attempt: number): void => {
    if (task.running.get(n.nodeId) !== attempt) return;
    const bytes = bytesFor(task, false);
    void sha256Hex(bytes).then((hash) => {
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
      opts.store.set(hash, done === DEMO_SCRAMBLED_AT - 1 ? bytesFor(task, true) : bytes);
      task.status = "done";
      task.output = hash;
      emit({
        t: "taskDone",
        taskId: task.taskId,
        nodeId: n.nodeId,
        output: hash,
        place: task.place,
        computeMs: ms,
      });
      done += 1;
      beat();
      if (pauseAtDone > 0 && done >= pauseAtDone) {
        pause();
        return;
      }
      if (done >= DEMO_TASKS) finish();
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

  /** The story, keyed by tiles done in the frame. */
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

  const finish = (): void => {
    if (!execution) return;
    const root = PROGRAM.split("").reverse().join("");
    emit({ t: "stageDone", executionId: execution.executionId, stage: 0, root });
    after(300, () => {
      if (!execution) return;
      emit({
        t: "executionDone",
        executionId: execution.executionId,
        root,
        followUp: { preset: (frame + 1) % PRESETS.length, palette: "ocean" },
      });
      after(2_500, startFrame);
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
    fill();
    if (pending.length === 0 && done >= DEMO_TASKS) finish();
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
        const reason = c.t === "restart" ? "restarted" : c.t === "skip" ? "skipped" : "cancelled";
        for (const h of timers) clearTimeout(h);
        timers = new Set();
        for (const t of tasks) t.running.clear();
        emit({ t: "executionFailed", executionId: execution.executionId, reason });
        emit({ t: "controlApplied", op: c.t, nodeIds: [] });
        execution = null;
        after(600, startFrame);
        return;
      }
      case "setRedundancy":
        redundancy = c.on;
        emit({ t: "controlApplied", op: "setRedundancy", nodeIds: [] });
        fill();
        return;
      case "launch":
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
  after(400, startFrame);

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
