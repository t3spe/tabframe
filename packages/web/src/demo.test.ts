import { describe, expect, test } from "bun:test";
import { applyMessage, type ClusterState, emptyState } from "./cluster-state.ts";
import { DEMO_SLEEP_REASON, DEMO_TASKS, type DemoTimers, startDemo } from "./demo.ts";
import { barRows, finalOutput, parseManifest, readBars } from "./result.ts";
import { hostCount, machineBanner, progress } from "./selectors.ts";
import { type TileFlag, type TilePainter, TileView } from "./tiles.ts";

/** Timers fired by hand, earliest due first (FIFO on ties), so a frame runs in milliseconds. */
class ManualTimers implements DemoTimers {
  private queue: Array<{ id: number; due: number; fn: () => void }> = [];
  private nextId = 1;
  time = 0;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.queue.push({ id, due: this.time + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.queue = this.queue.filter((t) => t.id !== handle);
  }
  get pending(): number {
    return this.queue.length;
  }
  /** Fire the next timer; false when none is due. */
  step(): boolean {
    this.queue.sort((a, b) => a.due - b.due || a.id - b.id);
    const next = this.queue.shift();
    if (!next) return false;
    this.time = next.due;
    next.fn();
    return true;
  }
}

/** Let the hashing and the store writes behind an event settle before the next timer. */
const settle = async (turns = 4): Promise<void> => {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
};

class NullPainter implements TilePainter {
  reset(): void {}
  put(): void {}
  flag(): void {}
  clear(): void {}
}

/** Run the demo under a manual scheduler until it pauses, with the reducer and the tile view following. */
async function runDemo(query: {
  pauseAtDone?: number;
  startWith?: "mandelbrot" | "wordcount" | "broken";
  holdAfterFirst?: boolean;
}) {
  const timers = new ManualTimers();
  const store = new Map<string, Uint8Array>();
  let clockMs = 1_700_000_000_000;
  const clock = {
    now: () => clockMs,
    set: (ms: number) => {
      clockMs = ms;
    },
  };
  let state: ClusterState = emptyState();
  const tiles = new TileView({ get: async (h) => store.get(h) ?? null }, new NullPainter());
  let paused = false;
  const handle = startDemo({
    apply: (msg) => {
      state = applyMessage(state, msg, clock.now());
      tiles.sync(state);
    },
    store,
    clock,
    timers,
    onPause: () => {
      paused = true;
    },
    ...query,
  });
  let idle = 0;
  while (!paused) {
    if (timers.step()) {
      idle = 0;
      await settle();
    } else {
      await settle();
      if (++idle > 50) throw new Error("the demo stalled with nothing scheduled");
    }
  }
  for (let i = 0; i < 200 && tiles.stats.inFlight > 0; i++) await settle();
  return { state, store, tiles, handle, clock };
}

describe("the demo machine under a manual scheduler", () => {
  test("paused at 300 tiles, the frame reads as the dashboard suite pins it", async () => {
    const { state, tiles, handle, clock } = await runDemo({ pauseAtDone: 300 });
    expect(handle.paused).toBe(true);
    expect(handle.done).toBe(300);
    expect(progress(state)).toEqual({ done: 300, total: DEMO_TASKS });
    expect(state.execution).toMatchObject({ programName: "mandelbrot", phase: "running" });
    // The stage event carried 256 rows; the rest were placed from their ids.
    expect(state.tasks.size).toBeGreaterThanOrEqual(300);
    expect([...state.tasks.values()].some((t) => t.index >= 256)).toBe(true);
    // Every finished tile but the scrambled one was fetched, re-hashed, and painted.
    expect(tiles.paintedCount).toBe(299);
    expect([...tiles.flags.values()]).toEqual(["bad-hash" satisfies TileFlag]);
    // The counters mirror the core's: the planner's task counts as done too.
    expect(state.execution?.counters).toMatchObject({ done: 301, mismatched: 1 });
    expect(state.execution?.counters.speculated).toBeGreaterThanOrEqual(2);
    expect(state.execution?.counters.reassigned).toBeGreaterThanOrEqual(1);
    const lines = state.activity.map((a) => a.text);
    expect(lines).toContain("killHalf: n2 core-2 n6");
    expect(lines.some((l) => l.includes("results disagree"))).toBe(true);
    expect(state.nodes.size).toBe(5);
    expect(hostCount(state)).toBe(4);
    expect(state.queue[0]).toMatchObject({
      executionId: "e39",
      programName: "wordcount",
      human: true,
    });
    // The header's rotation pill: nineteen minutes away at the snapshot, read on the frozen clock.
    const due = state.machine?.nextRotationAt ?? 0;
    expect([18, 19]).toContain(Math.ceil((due - clock.now()) / 60_000));
  });

  test("at 520 tiles the rotation is announced and the countdown holds while paused", async () => {
    const { state, clock } = await runDemo({ pauseAtDone: 520 });
    expect(state.generation).toBe(7);
    expect(state.rotation?.next).toBe(8);
    expect(machineBanner(state, clock.now())).toEqual({ kind: "rotating", next: 8, msLeft: 2_400 });
  });

  test("at 600 tiles the new generation's snapshot has landed and the picture survived", async () => {
    const { state, tiles } = await runDemo({ pauseAtDone: 600 });
    expect(state.generation).toBe(8);
    expect(state.tasks.size).toBe(DEMO_TASKS);
    expect(progress(state)).toEqual({ done: 600, total: DEMO_TASKS });
    expect(tiles.paintedCount).toBe(599);
    expect(state.activity.some((a) => a.text.includes("rotating to generation 8"))).toBe(true);
  });

  test("the word count runs three stages, folds a filesystem, and draws its bars", async () => {
    const { state, store } = await runDemo({ startWith: "wordcount", holdAfterFirst: true });
    const exec = state.execution;
    expect(exec).toMatchObject({ programName: "wordcount", phase: "done" });
    expect(progress(state)).toEqual({ done: 1, total: 1 });
    expect(exec?.stages.map((s) => [s.name, s.status, s.done, s.taskCount])).toEqual([
      ["map", "done", 8, 8],
      ["reduce", "done", 8, 8],
      ["merge", "done", 1, 1],
    ]);
    expect(exec?.warnings).toEqual([
      "the filesystem inherited from e38 is gone; starting from the bundle",
    ]);
    const root = exec?.root ?? "";
    const manifest = parseManifest(store.get(root) as Uint8Array);
    const paths = Object.keys(manifest.files);
    for (const p of ["/program.wasm", "/manifest.json", "/in/corpus.txt", "/out/0/7", "/out/2/0"])
      expect(paths).toContain(p);
    const final = finalOutput(manifest);
    expect(final?.path).toBe("/out/2/0");
    const bars = readBars(store.get(final?.hash ?? "") as Uint8Array);
    if (!bars.ok) throw new Error(bars.error);
    const rows = barRows(bars.bars);
    expect(rows).toHaveLength(25);
    expect(rows[0]).toMatchObject({ label: "the", value: 14529 });
    // The merge task's log went to the store by hash.
    const merge = [...state.tasks.values()].find((t) => t.stage === 2);
    expect(merge?.log && "hash" in merge.log).toBe(true);
  });

  test("the broken program fails its planner visibly and the machine goes to sleep", async () => {
    const { state } = await runDemo({ startWith: "broken", holdAfterFirst: true });
    expect(state.execution).toMatchObject({ programName: "broken", phase: "failed" });
    expect(progress(state)).toEqual({ done: 0, total: 0 });
    expect(state.lastFailure?.reason).toContain("trap: unreachable");
    expect(state.activity.some((a) => a.text.includes("failed: task"))).toBe(true);
    expect(machineBanner(state, 0)).toEqual({ kind: "sleeping", reason: DEMO_SLEEP_REASON });
  });

  test("controls are answered at once, and what the demo cannot do lands as an error line", async () => {
    let state = emptyState();
    const machine = startDemo({
      apply: (msg) => {
        state = applyMessage(state, msg, 0);
      },
      store: new Map(),
      timers: new ManualTimers(),
    });
    expect(state.nodes.size).toBe(6);
    machine.control({ t: "killHalf" });
    expect(state.activity.at(-1)?.text).toMatch(/^killHalf: \S+/);
    machine.control({ t: "setRedundancy", on: true });
    expect(state.activity.at(-1)?.text).toBe("setRedundancy");
    machine.control({ t: "stop" });
    expect(state.machine?.stopped).toBe(true);
    machine.control({ t: "runFollowUp", executionId: "e1" });
    expect(state.activity.at(-1)).toMatchObject({ kind: "error" });
  });
});
