import { describe, expect, test } from "bun:test";
import type { ControlPlaneToObserver, ExecutionView, TaskView } from "@tabframe/protocol";
import { PROTOCOL_VERSION } from "@tabframe/protocol";
import {
  ACTIVITY_CAP,
  applyMessage,
  CHART_WINDOW_MS,
  type ClusterState,
  emptyState,
  FLASH_MS,
  HISTORY_CAP,
  headerSlot,
  hostCount,
  inFlightByNode,
  isFlashing,
  isRunning,
  ledgerRows,
  loopLabel,
  loopState,
  machineBanner,
  PULSE_CAP,
  planTask,
  programList,
  progress,
  rotationCountdown,
  stageStrip,
  stageTasks,
  stopTitle,
  TASK_COLOR_LABELS,
  THROUGHPUT_WINDOW_MS,
  taskColor,
  throughput,
  throughputSeries,
  withRedundancy,
} from "./state.ts";

const env = { v: PROTOCOL_VERSION, gen: 2 } as const;
const HASH = "a".repeat(64);
const node = (id: string, hostId = "h1") => ({
  nodeId: id,
  hostId,
  kind: "tab" as const,
  health: "fast" as const,
  visible: true,
  tasksDone: 0,
  lastTaskMs: null,
  inFlight: 0,
  joinedAt: 1,
});
const taskView = (taskId: string, index: number, extra: Partial<TaskView> = {}): TaskView => ({
  taskId,
  executionId: "e1",
  stage: 0,
  index,
  kind: "run",
  status: "pending",
  holders: [],
  attempts: 0,
  output: null,
  place: { x: index * 64, y: 0, w: 64, h: 64 },
  contested: false,
  ...extra,
});
const executionView = (extra: Partial<ExecutionView> = {}): ExecutionView => ({
  executionId: "e1",
  program: HASH,
  programName: "mandelbrot",
  status: "running",
  human: false,
  view: "tiles",
  params: { preset: 0 },
  stage: 0,
  stageName: "",
  taskCount: 0,
  canvas: { w: 2048, h: 1280 },
  root: null,
  counters: {
    pending: 0,
    assigned: 0,
    done: 0,
    failed: 0,
    reassigned: 0,
    speculated: 0,
    verified: 0,
    mismatched: 0,
  },
  startedAt: 100,
  ...extra,
});

type Event = Extract<ControlPlaneToObserver, { seq: number }>;
/** An event without its envelope and sequence number (distributive over the union). */
type Bare = Event extends infer E
  ? E extends Event
    ? Omit<E, "seq" | "v" | "gen">
    : never
  : never;

/** Applies events with automatic sequence numbers so tests read as a script. */
class Script {
  state: ClusterState;
  seq: number;
  now: number;
  constructor(seq = 10, now = 1_000) {
    this.seq = seq;
    this.now = now;
    this.state = applyMessage(
      emptyState(),
      {
        t: "snapshot",
        ...env,
        seq,
        page: 0,
        pages: 1,
        nodes: [node("n1"), node("n2", "h2")],
        execution: null,
        queue: [],
        machine: {
          awake: true,
          reason: null,
          redundancy: false,
          nextRotationAt: null,
          uptimeMs: 5,
        },
        tasks: [],
        at: 0,
      },
      now,
    );
  }
  send(msg: Bare, dt = 10): ClusterState {
    this.now += dt;
    this.seq += 1;
    const full = { ...msg, ...env, seq: this.seq } as ControlPlaneToObserver;
    this.state = applyMessage(this.state, full, this.now);
    return this.state;
  }
  startStage(count = 4, carried = count) {
    this.send({ t: "executionStarted", execution: executionView() });
    const tasks = Array.from({ length: carried }, (_, i) => taskView(`t${i + 1}`, i));
    this.send({
      t: "stageStarted",
      executionId: "e1",
      stage: 0,
      name: "render",
      taskCount: count,
      canvas: { w: 2048, h: 1280 },
      tasks,
    });
    return this.state;
  }
}

describe("cluster state: snapshots and sequence", () => {
  test("snapshot pages accumulate nodes and tasks, then complete", () => {
    let s = emptyState();
    s = applyMessage(s, {
      t: "snapshot",
      ...env,
      seq: 10,
      page: 0,
      pages: 2,
      nodes: [node("n1")],
      execution: executionView({ taskCount: 3 }),
      queue: [{ executionId: "e2", programName: "wordcount", human: true, queuedAt: 3 }],
      machine: { awake: true, reason: null, redundancy: true, nextRotationAt: null, uptimeMs: 1 },
      tasks: [taskView("t1", 0), taskView("t2", 1)],
      at: 5,
    });
    expect(s.pagesPending).toBe(1);
    expect(s.generation).toBe(2);
    expect(s.machine?.redundancy).toBe(true);
    expect(s.queue.map((q) => q.executionId)).toEqual(["e2"]);
    expect(s.execution?.phase).toBe("running");
    s = applyMessage(s, {
      t: "snapshot",
      ...env,
      seq: 10,
      page: 1,
      pages: 2,
      nodes: [node("n2", "h2")],
      tasks: [taskView("t3", 2)],
      at: 5,
    });
    expect(s.pagesPending).toBe(0);
    expect([...s.nodes.keys()]).toEqual(["n1", "n2"]);
    expect([...s.tasks.keys()]).toEqual(["t1", "t2", "t3"]);
    expect(s.execution?.idBase).toBe(1);
    expect(hostCount(s)).toBe(2);
    expect(s.seq).toBe(10);
    expect(progress(s)).toEqual({ done: 0, total: 3 });
  });
  test("events in sequence apply; a skipped sequence number flags a gap", () => {
    const sc = new Script(3);
    let s = sc.send({ t: "nodeJoined", node: node("n3") });
    expect(s.nodes.has("n3")).toBe(true);
    expect(s.gap).toBe(false);
    s = sc.send({ t: "nodeHealth", nodeId: "n3", health: "throttled" });
    expect(s.nodes.get("n3")?.health).toBe("throttled");
    sc.seq += 1; // skip one
    s = sc.send({ t: "nodeLeft", nodeId: "n3", reason: "closed" });
    expect(s.nodes.has("n3")).toBe(false);
    expect(s.gap).toBe(true);
    expect(s.seq).toBe(7);
    expect(s.activity.at(-1)?.text).toContain("n3 left (closed)");
  });
  test("a pong ahead of the last seen sequence flags a gap; errors land in the activity list", () => {
    const sc = new Script(3);
    let s = applyMessage(sc.state, { t: "pong", ...env, seq: 3 });
    expect(s.gap).toBe(false);
    s = applyMessage(s, { t: "pong", ...env, seq: 9 });
    expect(s.gap).toBe(true);
    const presigned = applyMessage(s, { t: "presigned", ...env, urls: [] });
    expect(presigned).toBe(s);
    s = applyMessage(s, { t: "error", ...env, code: "launch-refused", message: "no such program" });
    expect(s.activity.at(-1)).toMatchObject({
      kind: "error",
      text: "launch-refused: no such program",
    });
    // A pong never advances the sequence: only events and snapshots do.
    expect(s.seq).toBe(3);
  });
  test("the loop's yield and its return are announced (WP6.8)", () => {
    const sc = new Script(3);
    sc.send({ t: "loopYielded", yielded: true });
    expect(sc.state.machine?.yielded).toBe(true);
    expect(sc.state.activity.at(-1)?.text).toContain("yielded to you");
    sc.send({ t: "loopYielded", yielded: false });
    expect(sc.state.machine?.yielded).toBe(false);
  });
  test("a fresh first page replaces nodes, tasks, and banners; unknown-node health is ignored", () => {
    const sc = new Script(3);
    sc.startStage(2);
    sc.send({ t: "controlPlaneRotating", next: 3, reconnectAfterMs: 2_000 });
    sc.send({ t: "machineSleeping", reason: "no observers" });
    expect(sc.state.rotation?.next).toBe(3);
    expect(sc.state.sleeping).toBe("no observers");
    const s = applyMessage(sc.state, {
      t: "snapshot",
      ...env,
      seq: 40,
      page: 0,
      pages: 1,
      nodes: [node("n9")],
      execution: null,
      tasks: [],
      at: 0,
    });
    expect([...s.nodes.keys()]).toEqual(["n9"]);
    expect(s.tasks.size).toBe(0);
    expect(s.execution).toBeNull();
    expect(s.rotation).toBeNull();
    expect(s.sleeping).toBeNull();
    expect(s.activity.length).toBeGreaterThan(0);
    const t = applyMessage(s, {
      t: "nodeHealth",
      ...env,
      seq: 41,
      nodeId: "ghost",
      health: "slow",
    });
    expect(t.nodes.size).toBe(1);
  });
});

describe("cluster state: executions and tasks", () => {
  test("queue, start, stage, done, and follow-up flow through the execution view", () => {
    const sc = new Script();
    sc.send({
      t: "executionQueued",
      entry: { executionId: "e1", programName: "mandelbrot", human: false, queuedAt: 1 },
    });
    sc.send({
      t: "executionQueued",
      entry: { executionId: "e1", programName: "mandelbrot", human: false, queuedAt: 1 },
    });
    expect(sc.state.queue.length).toBe(1);
    sc.send({ t: "executionStarted", execution: executionView() });
    expect(sc.state.queue.length).toBe(0);
    expect(sc.state.execution?.phase).toBe("planning");
    // The planner runs as a task before the stage exists.
    sc.send({ t: "taskAssigned", taskId: "t0", nodeId: "n1", attempt: 1 });
    expect(planTask(sc.state)?.kind).toBe("plan");
    expect(planTask(sc.state)?.holders).toEqual(["n1"]);
    sc.send({
      t: "taskDone",
      taskId: "t0",
      nodeId: "n1",
      output: HASH,
      place: null,
      computeMs: 30,
    });
    expect(planTask(sc.state)).toBeNull();
    sc.send({
      t: "stageStarted",
      executionId: "e1",
      stage: 0,
      name: "render",
      taskCount: 2,
      canvas: { w: 128, h: 64 },
      tasks: [taskView("t1", 0), taskView("t2", 1)],
    });
    const exec = sc.state.execution;
    expect(exec?.phase).toBe("running");
    expect(exec?.stageName).toBe("render");
    expect(exec?.taskCount).toBe(2);
    expect(exec?.canvas).toEqual({ w: 128, h: 64 });
    expect(exec?.counters.pending).toBe(2);
    expect(stageTasks(sc.state).map((t) => t.taskId)).toEqual(["t1", "t2"]);
    sc.send({ t: "budget", executionId: "e1", computeMsUsed: 500, computeMsCap: 60_000 });
    expect(sc.state.execution?.budget).toEqual({ used: 500, cap: 60_000 });
    sc.send({ t: "stageDone", executionId: "e1", stage: 0, root: HASH });
    expect(sc.state.execution?.phase).toBe("folding");
    expect(sc.state.execution?.root).toBe(HASH);
    sc.send({ t: "executionDone", executionId: "e1", root: HASH, followUp: { preset: 1 } });
    expect(sc.state.execution?.phase).toBe("done");
    expect(sc.state.execution?.status).toBe("done");
    expect(sc.state.execution?.followUp).toEqual({ preset: 1 });
    expect(sc.state.activity.at(-1)?.text).toContain("follow-up offered");
  });
  test("stage events for another execution are ignored; failure keeps the reason", () => {
    const sc = new Script();
    sc.startStage(1);
    const before = sc.state.execution;
    sc.send({
      t: "stageStarted",
      executionId: "other",
      stage: 1,
      name: "x",
      taskCount: 9,
      canvas: null,
      tasks: [],
    });
    sc.send({ t: "stageDone", executionId: "other", stage: 1, root: HASH });
    sc.send({ t: "budget", executionId: "other", computeMsUsed: 1, computeMsCap: 2 });
    expect(sc.state.execution?.taskCount).toBe(before?.taskCount);
    expect(sc.state.execution?.budget).toBeNull();
    sc.send({ t: "executionFailed", executionId: "e1", reason: "trap: unreachable" });
    expect(sc.state.execution?.phase).toBe("failed");
    expect(sc.state.execution?.failure).toBe("trap: unreachable");
    sc.send({ t: "executionDone", executionId: "other", root: null, followUp: null });
    expect(sc.state.execution?.phase).toBe("failed");
  });
  test("assign, done, and per-node bookkeeping mirror the core's counters", () => {
    const sc = new Script();
    sc.startStage(2);
    sc.send({ t: "taskAssigned", taskId: "t1", nodeId: "n1", attempt: 1 });
    sc.send({ t: "taskAssigned", taskId: "t2", nodeId: "n2", attempt: 1 });
    let c = sc.state.execution?.counters;
    expect(c).toMatchObject({ pending: 0, assigned: 2, done: 0 });
    expect(inFlightByNode(sc.state).get("n1")).toBe(1);
    expect(taskColor(sc.state.tasks.get("t1") as never)).toBe("assigned");
    sc.send({
      t: "taskDone",
      taskId: "t1",
      nodeId: "n1",
      output: HASH,
      place: { x: 0, y: 0, w: 64, h: 64 },
      computeMs: 420,
    });
    c = sc.state.execution?.counters;
    expect(c).toMatchObject({ pending: 0, assigned: 1, done: 1 });
    const t1 = sc.state.tasks.get("t1");
    expect(t1?.status).toBe("done");
    expect(t1?.output).toBe(HASH);
    expect(t1?.holders).toEqual([]);
    expect(t1?.computeMs).toBe(420);
    expect(taskColor(t1 as never)).toBe("done");
    expect(sc.state.nodes.get("n1")).toMatchObject({ tasksDone: 1, lastTaskMs: 420 });
    expect(inFlightByNode(sc.state).get("n1")).toBeUndefined();
    expect(progress(sc.state)).toEqual({ done: 1, total: 2 });
    // A done event for a task never assigned (the dashboard missed it) still counts once.
    sc.send({ t: "taskDone", taskId: "t2", nodeId: "n2", output: HASH, place: null, computeMs: 5 });
    expect(sc.state.execution?.counters).toMatchObject({ pending: 0, assigned: 0, done: 2 });
    expect(sc.state.tasks.get("t2")?.place).toEqual({ x: 64, y: 0, w: 64, h: 64 });
  });
  test("reassignment releases the task, flashes it, and counts once per release", () => {
    const sc = new Script();
    sc.startStage(1);
    sc.send({ t: "taskAssigned", taskId: "t1", nodeId: "n1", attempt: 1 });
    sc.send({ t: "taskReassigned", taskId: "t1", fromNode: "n1" });
    const t = sc.state.tasks.get("t1");
    expect(t?.status).toBe("pending");
    expect(t?.holders).toEqual([]);
    expect(isFlashing(t?.flashAt ?? null, sc.now)).toBe(true);
    expect(isFlashing(t?.flashAt ?? null, sc.now + FLASH_MS)).toBe(false);
    expect(sc.state.execution?.counters).toMatchObject({ pending: 1, assigned: 0, reassigned: 1 });
    expect(sc.state.activity.at(-1)?.text).toContain("taken back from n1");
    // A twin's release while the other holder keeps running is not a reassignment.
    sc.send({ t: "taskAssigned", taskId: "t1", nodeId: "n2", attempt: 2 });
    sc.send({ t: "taskSpeculated", taskId: "t1", nodeId: "n1" });
    expect(taskColor(sc.state.tasks.get("t1") as never)).toBe("speculated");
    expect(sc.state.execution?.counters.speculated).toBe(1);
    sc.send({ t: "taskReassigned", taskId: "t1", fromNode: "n1" });
    expect(sc.state.tasks.get("t1")?.status).toBe("assigned");
    expect(sc.state.tasks.get("t1")?.holders).toEqual(["n2"]);
    expect(sc.state.execution?.counters.reassigned).toBe(1);
    expect(sc.state.tasks.get("t1")?.attempts).toBe(3);
  });
  test("speculation, verification, mismatch retraction, and the majority vote", () => {
    const sc = new Script();
    sc.startStage(1);
    sc.send({ t: "taskAssigned", taskId: "t1", nodeId: "n1", attempt: 1 });
    sc.send({ t: "taskSpeculated", taskId: "t1", nodeId: "n2" });
    expect(sc.state.tasks.get("t1")?.holders).toEqual(["n1", "n2"]);
    expect(inFlightByNode(sc.state)).toEqual(
      new Map([
        ["n1", 1],
        ["n2", 1],
      ]),
    );
    sc.send({ t: "taskDone", taskId: "t1", nodeId: "n2", output: HASH, place: null, computeMs: 9 });
    sc.send({ t: "taskVerified", taskId: "t1", nodeId: "n1" });
    let t = sc.state.tasks.get("t1");
    expect(t?.verified).toBe(true);
    expect(taskColor(t as never)).toBe("verified");
    expect(sc.state.execution?.counters).toMatchObject({ done: 1, verified: 1, speculated: 1 });
    expect(sc.state.nodes.get("n1")?.tasksDone).toBe(1);
    // A third result disagrees: the tile is withdrawn and the task goes back to pending, contested.
    sc.send({ t: "taskMismatch", taskId: "t1", nodeId: "n3" });
    t = sc.state.tasks.get("t1");
    expect(t?.status).toBe("pending");
    expect(t?.output).toBeNull();
    expect(t?.contested).toBe(true);
    expect(t?.verified).toBe(false);
    expect(taskColor(t as never)).toBe("mismatch");
    expect(isFlashing(t?.flashAt ?? null, sc.now)).toBe(true);
    expect(sc.state.execution?.counters).toMatchObject({ done: 0, pending: 1, mismatched: 1 });
    expect(sc.state.activity.at(-1)?.text).toContain("results disagree");
    // Verification of a task the dashboard never saw only counts.
    sc.send({ t: "taskVerified", taskId: "ghost", nodeId: "n1" });
    expect(sc.state.tasks.has("ghost")).toBe(false);
    expect(sc.state.execution?.counters.verified).toBe(2);
    // The recompute settles by vote: done again, still marked contested.
    sc.send({ t: "taskAssigned", taskId: "t1", nodeId: "n2", attempt: 4 });
    sc.send({ t: "taskDone", taskId: "t1", nodeId: "n2", output: HASH, place: null, computeMs: 9 });
    t = sc.state.tasks.get("t1");
    expect(t?.status).toBe("done");
    expect(t?.contested).toBe(true);
    expect(taskColor(t as never)).toBe("done");
  });
  test("a mismatch on an assigned task and on a failed task keeps the counters sane", () => {
    const sc = new Script();
    sc.startStage(2);
    sc.send({ t: "taskAssigned", taskId: "t1", nodeId: "n1", attempt: 1 });
    sc.send({ t: "taskMismatch", taskId: "t1", nodeId: "n1" });
    expect(sc.state.execution?.counters).toMatchObject({ pending: 2, assigned: 0, mismatched: 1 });
    sc.send({ t: "taskAssigned", taskId: "t2", nodeId: "n2", attempt: 1 });
    sc.send({ t: "taskFailed", taskId: "t2", reason: "trap" });
    expect(sc.state.tasks.get("t2")).toMatchObject({
      status: "failed",
      failure: "trap",
      holders: [],
    });
    expect(taskColor(sc.state.tasks.get("t2") as never)).toBe("failed");
    expect(sc.state.execution?.counters).toMatchObject({ pending: 1, assigned: 0, failed: 1 });
    sc.send({ t: "taskMismatch", taskId: "t2", nodeId: "n2" });
    expect(sc.state.execution?.counters).toMatchObject({ pending: 2, failed: 1, mismatched: 2 });
    sc.send({ t: "taskFailed", taskId: "t9", reason: "never assigned" });
    expect(sc.state.execution?.counters).toMatchObject({ pending: 1, failed: 2 });
  });
  test("rows the stage event could not carry are placed from their ids; odd ids stay unplaced", () => {
    const sc = new Script();
    sc.startStage(300, 256);
    expect(sc.state.execution?.idBase).toBe(1);
    sc.send({ t: "taskAssigned", taskId: "t300", nodeId: "n1", attempt: 1 });
    expect(sc.state.tasks.get("t300")?.index).toBe(299);
    expect(sc.state.tasks.get("t300")?.kind).toBe("run");
    sc.send({ t: "taskAssigned", taskId: "t900", nodeId: "n1", attempt: 1 });
    expect(sc.state.tasks.get("t900")?.index).toBe(-1);
    sc.send({ t: "taskAssigned", taskId: "weird", nodeId: "n1", attempt: 1 });
    expect(sc.state.tasks.get("weird")?.index).toBe(-1);
    // A duplicate index is refused rather than painted twice on the grid.
    sc.send({ t: "taskAssigned", taskId: "t2", nodeId: "n2", attempt: 1 });
    const order = stageTasks(sc.state);
    expect(order.length).toBe(259);
    expect(order[1]?.taskId).toBe("t2");
    expect(order[256]?.taskId).toBe("t300");
    expect(order.slice(257).map((t) => t.taskId)).toEqual(["t900", "weird"]);
    expect(progress(sc.state).total).toBe(300);
  });
  test("ids that are not consecutive give no base, so unknown rows are unplaced", () => {
    const sc = new Script();
    sc.send({ t: "executionStarted", execution: executionView() });
    sc.send({
      t: "stageStarted",
      executionId: "e1",
      stage: 0,
      name: "render",
      taskCount: 5,
      canvas: null,
      tasks: [taskView("t1", 0), taskView("t7", 1)],
    });
    expect(sc.state.execution?.idBase).toBeNull();
    sc.send({ t: "taskAssigned", taskId: "t3", nodeId: "n1", attempt: 1 });
    expect(sc.state.tasks.get("t3")?.index).toBe(-1);
  });
  test("task events before any execution still track the task without counters", () => {
    const sc = new Script();
    sc.send({ t: "taskAssigned", taskId: "t5", nodeId: "n1", attempt: 1 });
    expect(sc.state.tasks.get("t5")?.status).toBe("assigned");
    expect(sc.state.execution).toBeNull();
    expect(stageTasks(sc.state)).toEqual([]);
    expect(progress(sc.state)).toEqual({ done: 0, total: 0 });
  });
});

describe("cluster state: throughput, controls, and system events", () => {
  test("throughput counts taskDone arrivals inside the window and forgets older ones", () => {
    const sc = new Script(10, 100_000);
    sc.startStage(6);
    for (let i = 1; i <= 5; i++) {
      sc.send({ t: "taskAssigned", taskId: `t${i}`, nodeId: "n1", attempt: 1 }, 0);
      sc.send(
        { t: "taskDone", taskId: `t${i}`, nodeId: "n1", output: HASH, place: null, computeMs: 1 },
        200,
      );
    }
    expect(sc.state.doneAt.length).toBe(5);
    expect(throughput(sc.state, sc.now)).toBeCloseTo(1, 5);
    expect(throughput(sc.state, sc.now + THROUGHPUT_WINDOW_MS)).toBe(0);
    // The next arrival prunes what fell out of the window.
    sc.send({ t: "taskAssigned", taskId: "t6", nodeId: "n1", attempt: 1 }, THROUGHPUT_WINDOW_MS);
    sc.send(
      { t: "taskDone", taskId: "t6", nodeId: "n1", output: HASH, place: null, computeMs: 1 },
      1,
    );
    expect(sc.state.doneAt.length).toBe(1);
    expect(throughput(sc.state, sc.now)).toBeCloseTo(0.2, 5);
  });
  test("controls name their victims, flash them, and a redundancy change asks for a refresh", () => {
    const sc = new Script();
    sc.send({ t: "controlApplied", op: "killHalf", nodeIds: ["n1"] });
    expect(sc.state.victims).toMatchObject({ op: "killHalf", nodeIds: ["n1"] });
    expect(isFlashing(sc.state.victims?.at ?? null, sc.now)).toBe(true);
    expect(sc.state.refresh).toBe(false);
    expect(sc.state.activity.at(-1)?.text).toBe("killHalf: n1");
    sc.send({ t: "controlApplied", op: "setRedundancy", nodeIds: [] });
    expect(sc.state.refresh).toBe(true);
    expect(sc.state.activity.at(-1)?.text).toBe("setRedundancy");
    const s = applyMessage(sc.state, {
      t: "snapshot",
      ...env,
      seq: sc.seq,
      page: 0,
      pages: 1,
      nodes: [],
      machine: { awake: true, reason: null, redundancy: true, nextRotationAt: null, uptimeMs: 9 },
      tasks: [],
      at: 0,
    });
    expect(s.refresh).toBe(false);
    expect(s.machine?.redundancy).toBe(true);
    expect(s.victims?.op).toBe("setRedundancy");
    // The toggling page applies its own value; without a machine view there is nothing to set.
    expect(withRedundancy(s, false).machine?.redundancy).toBe(false);
    expect(withRedundancy(emptyState(), true).machine).toBeNull();
  });
  test("programs, rotation, and sleep are recorded; the activity list is capped", () => {
    const sc = new Script();
    sc.send({ t: "programAdded", program: HASH, name: "wordcount" });
    expect(sc.state.programs.get(HASH)).toMatchObject({ name: "wordcount", view: null });
    sc.send({ t: "controlPlaneRotating", next: 3, reconnectAfterMs: 2_500 });
    expect(sc.state.rotation).toMatchObject({ next: 3, reconnectAfterMs: 2_500 });
    expect(sc.state.activity.at(-1)?.text).toContain("2.5 s");
    sc.send({ t: "machineSleeping", reason: "no observers for 10 min" });
    expect(sc.state.sleeping).toBe("no observers for 10 min");
    for (let i = 0; i < ACTIVITY_CAP + 10; i++)
      sc.send({ t: "nodeLeft", nodeId: `x${i}`, reason: "silent" });
    expect(sc.state.activity.length).toBe(ACTIVITY_CAP);
    expect(sc.state.activity.at(-1)?.text).toContain(`x${ACTIVITY_CAP + 9}`);
    expect(sc.state.activity.every((a, i, all) => i === 0 || (all[i - 1]?.seq ?? 0) <= a.seq)).toBe(
      true,
    );
  });
  test("snapshot pages beyond the first keep the cluster-level fields", () => {
    const sc = new Script();
    sc.send({ t: "controlPlaneRotating", next: 3, reconnectAfterMs: 1 });
    const s = applyMessage(sc.state, {
      t: "snapshot",
      ...env,
      seq: sc.seq,
      page: 1,
      pages: 2,
      tasks: [taskView("t1", 0)],
      at: 0,
    });
    expect(s.rotation?.next).toBe(3);
    expect(s.machine?.awake).toBe(true);
    expect(s.tasks.size).toBe(1);
  });
});

describe("dashboard v2: programs, stages, attempts, failures", () => {
  test("programs come from the snapshot with their views; programAdded fills in the rest", () => {
    let s = applyMessage(emptyState(), {
      t: "snapshot",
      ...env,
      seq: 1,
      page: 0,
      pages: 1,
      nodes: [],
      programs: [
        {
          bundle: HASH,
          name: "mandelbrot",
          view: "tiles",
          description: null,
          defaultParams: { preset: 0 },
          addedAt: 1,
        },
      ],
      execution: null,
      queue: [],
      machine: { awake: true, reason: null, redundancy: false, nextRotationAt: null, uptimeMs: 1 },
      tasks: [],
      at: 1,
    });
    expect(programList(s).map((p) => p.name)).toEqual(["mandelbrot"]);
    expect(s.programs.get(HASH)?.defaultParams).toEqual({ preset: 0 });
    s = applyMessage(s, { t: "programAdded", ...env, seq: 2, program: "b".repeat(64), name: "wc" });
    expect(programList(s).map((p) => p.name)).toEqual(["mandelbrot", "wc"]);
    expect(s.programs.get("b".repeat(64))?.view).toBeNull();
    // An announcement for a known program keeps what the snapshot said.
    s = applyMessage(s, { t: "programAdded", ...env, seq: 3, program: HASH, name: "mandelbrot" });
    expect(s.programs.get(HASH)?.view).toBe("tiles");
    // A retired program leaves the list and the activity says so.
    s = applyMessage(s, { t: "programRetired", ...env, seq: 4, program: HASH, name: "mandelbrot" });
    expect(programList(s).map((p) => p.name)).toEqual(["wc"]);
    expect(s.activity.at(-1)?.text).toContain("program mandelbrot retired");
  });

  test("the stage strip: a plan step, then stages with tallies and roots, then done", () => {
    const sc = new Script();
    sc.send({ t: "executionStarted", execution: executionView() });
    expect(stageStrip(sc.state)).toEqual([{ kind: "plan", stage: 0, holders: [] }]);
    sc.send({ t: "taskAssigned", taskId: "p1", nodeId: "n1", attempt: 1 });
    expect(stageStrip(sc.state)).toEqual([{ kind: "plan", stage: 0, holders: ["n1"] }]);
    sc.send({ t: "taskDone", taskId: "p1", nodeId: "n1", output: HASH, place: null, computeMs: 3 });
    sc.send({
      t: "stageStarted",
      executionId: "e1",
      stage: 0,
      name: "map",
      taskCount: 2,
      canvas: null,
      tasks: [taskView("t1", 0, { place: null }), taskView("t2", 1, { place: null })],
    });
    let strip = stageStrip(sc.state);
    expect(strip).toHaveLength(1);
    expect(strip[0]).toMatchObject({ kind: "stage", current: true });
    expect(sc.state.execution?.stages[0]).toMatchObject({ name: "map", taskCount: 2, done: 0 });
    sc.send({ t: "taskAssigned", taskId: "t1", nodeId: "n1", attempt: 1 });
    sc.send({ t: "taskDone", taskId: "t1", nodeId: "n1", output: HASH, place: null, computeMs: 5 });
    expect(sc.state.execution?.stages[0]?.done).toBe(1);
    sc.send({ t: "taskAssigned", taskId: "t2", nodeId: "n2", attempt: 1 });
    sc.send({ t: "taskDone", taskId: "t2", nodeId: "n2", output: HASH, place: null, computeMs: 5 });
    sc.send({ t: "stageDone", executionId: "e1", stage: 0, root: "e".repeat(64) });
    strip = stageStrip(sc.state);
    expect(strip).toHaveLength(2);
    expect(strip[0]).toMatchObject({
      kind: "stage",
      current: false,
      stage: { status: "done", done: 2, root: "e".repeat(64) },
    });
    expect(strip[1]).toEqual({ kind: "plan", stage: 1, holders: [] });
    sc.send({
      t: "stageStarted",
      executionId: "e1",
      stage: 1,
      name: "reduce",
      taskCount: 1,
      canvas: null,
      tasks: [taskView("t3", 0, { stage: 1, place: null })],
    });
    expect(sc.state.execution?.stages.map((s) => s.name)).toEqual(["map", "reduce"]);
    sc.send({ t: "taskAssigned", taskId: "t3", nodeId: "n1", attempt: 1 });
    sc.send({ t: "taskDone", taskId: "t3", nodeId: "n1", output: HASH, place: null, computeMs: 5 });
    sc.send({ t: "stageDone", executionId: "e1", stage: 1, root: "f".repeat(64) });
    sc.send({ t: "executionDone", executionId: "e1", root: "f".repeat(64), followUp: null });
    expect(sc.state.execution?.stages.every((s) => s.status === "done")).toBe(true);
    expect(stageStrip(sc.state).every((e) => e.kind === "stage")).toBe(true);
  });

  test("a snapshot mid-execution knows the current stage and that earlier ones happened", () => {
    const s = applyMessage(emptyState(), {
      t: "snapshot",
      ...env,
      seq: 1,
      page: 0,
      pages: 1,
      nodes: [],
      execution: executionView({ stage: 2, stageName: "merge", taskCount: 1 }),
      queue: [],
      machine: { awake: true, reason: null, redundancy: false, nextRotationAt: null, uptimeMs: 1 },
      tasks: [taskView("t9", 0, { stage: 2, status: "done", output: HASH, place: null })],
      at: 1,
    });
    const stages = s.execution?.stages ?? [];
    expect(stages.map((st) => st.known)).toEqual([false, false, true]);
    expect(stages[2]).toMatchObject({ name: "merge", taskCount: 1, done: 1, status: "running" });
  });

  test("a task's history follows its attempts: twins, releases, retractions, failures", () => {
    const sc = new Script();
    sc.startStage(2);
    sc.send({ t: "taskAssigned", taskId: "t1", nodeId: "n1", attempt: 1 });
    sc.send({ t: "taskSpeculated", taskId: "t1", nodeId: "n2" });
    let t1 = sc.state.tasks.get("t1");
    expect(t1?.history.map((a) => [a.attempt, a.nodeId, a.speculative, a.outcome])).toEqual([
      [1, "n1", false, "running"],
      [2, "n2", true, "running"],
    ]);
    // n2 answers first: its attempt is done, n1's is cancelled by the core.
    sc.send({ t: "taskDone", taskId: "t1", nodeId: "n2", output: HASH, place: null, computeMs: 7 });
    t1 = sc.state.tasks.get("t1");
    expect(t1?.history.map((a) => a.outcome)).toEqual(["cancelled", "done"]);
    expect(t1?.history[1]?.computeMs).toBe(7);
    // A late duplicate from n1 agrees: verified, recorded even though its attempt was closed.
    sc.send({ t: "taskVerified", taskId: "t1", nodeId: "n1" });
    expect(sc.state.tasks.get("t1")?.history.at(-1)).toMatchObject({
      nodeId: "n1",
      outcome: "verified",
    });
    // The other task: taken back, then a lying twin forces a retraction, then it fails.
    sc.send({ t: "taskAssigned", taskId: "t2", nodeId: "n1", attempt: 1 });
    sc.send({ t: "taskReassigned", taskId: "t2", fromNode: "n1" });
    expect(sc.state.tasks.get("t2")?.history[0]?.outcome).toBe("released");
    sc.send({ t: "taskAssigned", taskId: "t2", nodeId: "n2", attempt: 2 });
    sc.send({ t: "taskDone", taskId: "t2", nodeId: "n2", output: HASH, place: null, computeMs: 4 });
    sc.send({ t: "taskMismatch", taskId: "t2", nodeId: "n1" });
    const t2 = sc.state.tasks.get("t2");
    expect(t2?.history.map((a) => [a.nodeId, a.outcome])).toEqual([
      ["n1", "released"],
      ["n2", "retracted"],
      ["n1", "mismatch"],
    ]);
    sc.send({ t: "taskAssigned", taskId: "t2", nodeId: "n2", attempt: 3 });
    sc.send({ t: "taskFailed", taskId: "t2", reason: "trap: unreachable" });
    expect(sc.state.tasks.get("t2")?.history.at(-1)?.outcome).toBe("failed");
    expect(sc.state.tasks.get("t2")?.failure).toBe("trap: unreachable");
    expect(sc.state.execution?.stages[0]).toMatchObject({ done: 1, failed: 1 });
  });

  test("history is capped and a snapshot row reconstructs running attempts from its holders", () => {
    const sc = new Script();
    sc.startStage(1);
    for (let i = 1; i <= HISTORY_CAP + 4; i++) {
      sc.send({ t: "taskAssigned", taskId: "t1", nodeId: `n${i}`, attempt: i });
      sc.send({ t: "taskReassigned", taskId: "t1", fromNode: `n${i}` });
    }
    const t1 = sc.state.tasks.get("t1");
    expect(t1?.history).toHaveLength(HISTORY_CAP);
    expect(t1?.history.at(-1)?.attempt).toBe(HISTORY_CAP + 4);
    const s = applyMessage(emptyState(), {
      t: "snapshot",
      ...env,
      seq: 1,
      page: 0,
      pages: 1,
      nodes: [],
      execution: executionView({ taskCount: 1 }),
      queue: [],
      machine: { awake: true, reason: null, redundancy: false, nextRotationAt: null, uptimeMs: 1 },
      tasks: [taskView("t1", 0, { status: "assigned", holders: ["n1", "n2"], attempts: 3 })],
      at: 1,
    });
    expect(s.tasks.get("t1")?.history).toEqual([
      expect.objectContaining({ attempt: 2, nodeId: "n1", speculative: false, fromSnapshot: true }),
      expect.objectContaining({ attempt: 3, nodeId: "n2", speculative: true, fromSnapshot: true }),
    ]);
  });

  test("the accepted result's log rides on taskDone when the wire carries it", () => {
    const sc = new Script();
    sc.startStage(1);
    sc.send({ t: "taskAssigned", taskId: "t1", nodeId: "n1", attempt: 1 });
    sc.send({
      t: "taskDone",
      taskId: "t1",
      nodeId: "n1",
      output: HASH,
      place: null,
      computeMs: 4,
      log: { text: "64 rows" },
    });
    expect(sc.state.tasks.get("t1")?.log).toEqual({ text: "64 rows" });
  });

  test("a queued execution that is dropped leaves the queue without a banner", () => {
    const sc = new Script();
    sc.startStage(1);
    sc.send({
      t: "executionQueued",
      entry: { executionId: "e2", programName: "wordcount", human: true, queuedAt: 5 },
    });
    expect(sc.state.queue.map((q) => q.executionId)).toEqual(["e2"]);
    sc.send({ t: "executionFailed", executionId: "e2", reason: "cancelled by an operator" });
    expect(sc.state.queue).toEqual([]);
    expect(sc.state.lastFailure).toBeNull();
    expect(sc.state.execution?.phase).toBe("running");
    expect(sc.state.activity.at(-1)?.text).toBe("wordcount failed: cancelled by an operator");
  });

  test("warnings attach to the execution; a failure is kept until the next success", () => {
    const sc = new Script();
    sc.startStage(1);
    sc.send({
      t: "executionWarning",
      executionId: "e1",
      code: "expired-root",
      message: "the inherited filesystem is gone; starting from the bundle",
    });
    expect(sc.state.execution?.warnings).toEqual([
      "the inherited filesystem is gone; starting from the bundle",
    ]);
    sc.send({ t: "executionWarning", executionId: "e9", code: "expired-root", message: "other" });
    expect(sc.state.execution?.warnings).toHaveLength(1);
    sc.send({ t: "executionFailed", executionId: "e1", reason: "write conflict at /x" });
    expect(sc.state.lastFailure).toMatchObject({
      executionId: "e1",
      programName: "mandelbrot",
      reason: "write conflict at /x",
    });
    expect(sc.state.execution?.stages[0]?.status).toBe("failed");
    // The next execution starts; the failure stays visible until one succeeds.
    sc.send({ t: "executionStarted", execution: executionView({ executionId: "e2" }) });
    expect(sc.state.lastFailure?.executionId).toBe("e1");
    sc.send({ t: "executionDone", executionId: "e2", root: null, followUp: null });
    expect(sc.state.lastFailure).toBeNull();
  });
});

describe("dashboard polish: flash kinds, the released colour, the chart, banners, the ledger", () => {
  test("every event that moves a task flashes it with its kind and leaves a pulse", () => {
    const sc = new Script();
    sc.startStage(2);
    sc.send({ t: "taskAssigned", taskId: "t1", nodeId: "n1", attempt: 1 });
    expect(sc.state.tasks.get("t1")?.flashKind).toBeNull();
    sc.send({ t: "taskReassigned", taskId: "t1", fromNode: "n1" });
    let t1 = sc.state.tasks.get("t1");
    expect(t1).toMatchObject({ status: "pending", released: true, flashKind: "released" });
    expect(taskColor(t1 as never)).toBe("released");
    expect(sc.state.pulses.at(-1)).toMatchObject({
      taskId: "t1",
      kind: "released",
      nodeId: "n1",
      at: sc.now,
    });
    // Handed out again: the colour follows the holder; the kind stays as the last thing that happened.
    sc.send({ t: "taskAssigned", taskId: "t1", nodeId: "n2", attempt: 2 });
    t1 = sc.state.tasks.get("t1");
    expect(t1?.released).toBe(false);
    expect(taskColor(t1 as never)).toBe("assigned");
    expect(t1?.flashKind).toBe("released");
    sc.send({ t: "taskSpeculated", taskId: "t1", nodeId: "n1" });
    expect(sc.state.tasks.get("t1")?.flashKind).toBe("speculated");
    expect(isFlashing(sc.state.tasks.get("t1")?.flashAt ?? null, sc.now)).toBe(true);
    sc.send({ t: "taskDone", taskId: "t1", nodeId: "n2", output: HASH, place: null, computeMs: 3 });
    expect(sc.state.tasks.get("t1")?.settledAt).toBe(sc.now);
    sc.send({ t: "taskVerified", taskId: "t1", nodeId: "n1" });
    expect(sc.state.tasks.get("t1")?.flashKind).toBe("verified");
    sc.send({ t: "taskMismatch", taskId: "t1", nodeId: "n3" });
    expect(sc.state.tasks.get("t1")).toMatchObject({
      flashKind: "mismatch",
      released: false,
      settledAt: null,
    });
    expect(taskColor(sc.state.tasks.get("t1") as never)).toBe("mismatch");
    expect(sc.state.pulses.map((p) => p.kind)).toEqual([
      "released",
      "speculated",
      "verified",
      "mismatch",
    ]);
    // A verification for a task never seen leaves no pulse; the list is capped.
    sc.send({ t: "taskVerified", taskId: "ghost", nodeId: "n1" });
    expect(sc.state.pulses).toHaveLength(4);
    for (let i = 0; i < PULSE_CAP + 3; i++) {
      sc.send({ t: "taskAssigned", taskId: "t2", nodeId: "n1", attempt: i + 1 });
      sc.send({ t: "taskReassigned", taskId: "t2", fromNode: "n1" });
    }
    expect(sc.state.pulses).toHaveLength(PULSE_CAP);
    expect(sc.state.pulses.every((p) => p.taskId === "t2")).toBe(true);
    // A released task whose twin is still running keeps its holder's colour.
    sc.send({ t: "taskAssigned", taskId: "t2", nodeId: "n1", attempt: 30 });
    sc.send({ t: "taskSpeculated", taskId: "t2", nodeId: "n2" });
    sc.send({ t: "taskReassigned", taskId: "t2", fromNode: "n1" });
    expect(sc.state.tasks.get("t2")).toMatchObject({ status: "assigned", released: false });
    expect(taskColor(sc.state.tasks.get("t2") as never)).toBe("assigned");
  });

  test("the legend names every colour once, in the order a task passes through them", () => {
    const keys = TASK_COLOR_LABELS.map(([k]) => k);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([
      "pending",
      "assigned",
      "speculated",
      "released",
      "done",
      "verified",
      "mismatch",
      "failed",
    ]);
    expect(TASK_COLOR_LABELS.every(([, label]) => label.length > 0)).toBe(true);
  });

  test("the chart buckets taskDone arrivals per second over the last minute", () => {
    const sc = new Script(10, 200_000);
    sc.startStage(4);
    const land = (dt: number, id: string) => {
      sc.send({ t: "taskAssigned", taskId: id, nodeId: "n1", attempt: 1 }, dt);
      sc.send(
        { t: "taskDone", taskId: id, nodeId: "n1", output: HASH, place: null, computeMs: 1 },
        0,
      );
    };
    land(0, "t1");
    land(1_500, "t2");
    land(500, "t3");
    land(30_000, "t4");
    const now = sc.now;
    const series = throughputSeries(sc.state, now);
    expect(series).toHaveLength(CHART_WINDOW_MS / 1000);
    expect(series.reduce((a, b) => a + b, 0)).toBe(4);
    expect(series[59]).toBe(1); // t4, this second
    expect(series[29]).toBe(2); // t2 and t3, 30–31 s ago
    expect(series[27]).toBe(1); // t1, 32 s ago
    expect(throughputSeries(sc.state, now, 5)).toEqual([0, 0, 0, 0, 1]);
    expect(throughputSeries(sc.state, now + CHART_WINDOW_MS).every((v) => v === 0)).toBe(true);
    // The five-second rate has already forgotten the first three.
    expect(sc.state.doneAt).toHaveLength(1);
    expect(throughput(sc.state, now)).toBeCloseTo(0.2, 5);
    // The next arrival prunes what fell out of the chart window.
    land(CHART_WINDOW_MS + 1, "t5");
    expect(sc.state.doneLog).toHaveLength(1);
    expect(throughputSeries(sc.state, sc.now).reduce((a, b) => a + b, 0)).toBe(1);
  });

  test("the rotation countdown and the machine banner", () => {
    const sc = new Script();
    expect(machineBanner(sc.state, sc.now)).toBeNull();
    expect(rotationCountdown(null, 5)).toBeNull();
    sc.send({ t: "controlPlaneRotating", next: 3, reconnectAfterMs: 2_400 });
    const at = sc.now;
    expect(rotationCountdown(sc.state.rotation, at)).toBe(2_400);
    expect(rotationCountdown(sc.state.rotation, at + 1_000)).toBe(1_400);
    expect(rotationCountdown(sc.state.rotation, at + 9_000)).toBe(0);
    expect(machineBanner(sc.state, at + 400)).toEqual({ kind: "rotating", next: 3, msLeft: 2_000 });
    // Sleep is reported behind a rotation; the snapshot's asleep flag behind both.
    sc.send({ t: "machineSleeping", reason: "ten minutes with nobody watching" });
    expect(machineBanner(sc.state, sc.now)?.kind).toBe("rotating");
    const rested = { ...sc.state, rotation: null };
    expect(machineBanner(rested, sc.now)).toEqual({
      kind: "sleeping",
      reason: "ten minutes with nobody watching",
    });
    const asleep = applyMessage(
      rested,
      {
        t: "snapshot",
        ...env,
        seq: sc.seq,
        page: 0,
        pages: 1,
        nodes: [],
        machine: {
          awake: false,
          reason: "an hour without anyone touching the dashboard",
          redundancy: false,
          nextRotationAt: null,
          uptimeMs: 1,
        },
        tasks: [],
        at: 0,
      },
      sc.now,
    );
    expect(asleep.sleeping).toBeNull();
    expect(machineBanner(asleep, sc.now)).toEqual({
      kind: "asleep",
      reason: "an hour without anyone touching the dashboard",
    });
    expect(machineBanner({ ...asleep, machine: null }, sc.now)).toBeNull();
  });

  test("the ledger lists settled tasks newest first with their hashes and tile sizes", () => {
    const sc = new Script();
    sc.startStage(3);
    expect(ledgerRows(sc.state)).toEqual([]);
    sc.send({ t: "taskAssigned", taskId: "t1", nodeId: "n1", attempt: 1 });
    sc.send({ t: "taskAssigned", taskId: "t2", nodeId: "n2", attempt: 1 });
    sc.send({
      t: "taskDone",
      taskId: "t2",
      nodeId: "n2",
      output: "b".repeat(64),
      place: { x: 64, y: 0, w: 64, h: 64 },
      computeMs: 9,
    });
    sc.send({ t: "taskDone", taskId: "t1", nodeId: "n1", output: HASH, place: null, computeMs: 4 });
    sc.send({ t: "taskAssigned", taskId: "t3", nodeId: "n1", attempt: 1 });
    let rows = ledgerRows(sc.state);
    expect(rows.map((r) => r.taskId)).toEqual(["t1", "t2"]);
    expect(rows[0]).toMatchObject({
      output: HASH,
      size: 64 * 64 * 4,
      nodeId: "n1",
      computeMs: 4,
      verified: false,
    });
    expect(rows[1]).toMatchObject({ output: "b".repeat(64), size: 64 * 64 * 4, nodeId: "n2" });
    expect(ledgerRows(sc.state, 1).map((r) => r.taskId)).toEqual(["t1"]);
    // A result without a placed tile has no size the dashboard can name; a twin's agreement shows.
    sc.send({
      t: "taskDone",
      taskId: "t9",
      nodeId: "n2",
      output: "c".repeat(64),
      place: null,
      computeMs: 2,
    });
    sc.send({ t: "taskVerified", taskId: "t9", nodeId: "n1" });
    rows = ledgerRows(sc.state);
    expect(rows[0]).toMatchObject({ taskId: "t9", size: null, verified: true, nodeId: "n2" });
    // A retraction drops the row.
    sc.send({ t: "taskMismatch", taskId: "t1", nodeId: "n2" });
    expect(ledgerRows(sc.state).map((r) => r.taskId)).toEqual(["t9", "t2"]);
  });
});

describe("stop and start (WP6.1)", () => {
  test("the control's echo flips the machine's stopped flag without a refresh", () => {
    let s = applyMessage(emptyState(), {
      t: "snapshot",
      ...env,
      seq: 1,
      page: 0,
      pages: 1,
      nodes: [],
      programs: [],
      execution: null,
      queue: [],
      machine: {
        awake: true,
        reason: null,
        redundancy: false,
        stopped: false,
        nextRotationAt: null,
        uptimeMs: 1,
      },
      tasks: [],
      at: 1,
    });
    s = applyMessage(s, { t: "controlApplied", ...env, seq: 2, op: "stop", nodeIds: [] });
    expect(s.machine?.stopped).toBe(true);
    expect(s.refresh).toBe(false);
    expect(s.activity.at(-1)?.text).toContain("stop: the loop is held until Start");
    s = applyMessage(s, { t: "controlApplied", ...env, seq: 3, op: "start", nodeIds: [] });
    expect(s.machine?.stopped).toBe(false);
    // Pause and resume the same way (WP6.4).
    s = applyMessage(s, { t: "controlApplied", ...env, seq: 4, op: "pause", nodeIds: [] });
    expect(s.machine?.paused).toBe(true);
    s = applyMessage(s, { t: "controlApplied", ...env, seq: 5, op: "resume", nodeIds: [] });
    expect(s.machine?.paused).toBe(false);
  });
});

describe("the header's one slot and the loop pill (WP7.1)", () => {
  const machine = (flags: { stopped?: boolean; yielded?: boolean; paused?: boolean }) => ({
    awake: true,
    reason: null,
    redundancy: false,
    stopped: flags.stopped ?? false,
    yielded: flags.yielded ?? false,
    paused: flags.paused ?? false,
    nextRotationAt: null,
    uptimeMs: 0,
  });
  const execution = (phase: string, human = false) =>
    ({
      executionId: "e7",
      programName: "wordcount",
      phase,
      human,
    }) as unknown as ClusterState["execution"];
  const at = (
    flags: { stopped?: boolean; yielded?: boolean; paused?: boolean },
    exec: ClusterState["execution"] = null,
  ): ClusterState => ({ ...emptyState(), machine: machine(flags), execution: exec });

  test("the loop's state reads paused, held, yielded, running, in that order of precedence", () => {
    expect(loopState(at({}))).toBe("running");
    expect(loopState(at({ stopped: true }))).toBe("held");
    expect(loopState(at({ yielded: true }))).toBe("yielded");
    expect(loopState(at({ stopped: true, yielded: true }))).toBe("held");
    expect(loopState(at({ paused: true, stopped: true }))).toBe("paused");
    expect(loopState({ ...emptyState(), machine: null })).toBe("running");
    expect(loopLabel(at({ yielded: true }))).toBe("loop · yielded to you");
    expect(loopLabel(at({ paused: true }))).toBe("loop · paused by the editor");
  });

  test("the slot follows what a visitor can do now: Stop while anything runs, Start when idle and held", () => {
    for (const phase of ["planning", "running", "folding"]) {
      expect(isRunning(at({}, execution(phase)))).toBe(true);
      expect(headerSlot(at({}, execution(phase)))).toBe("stop");
      expect(headerSlot(at({ stopped: true }, execution(phase, true)))).toBe("stop");
      expect(headerSlot(at({ yielded: true }, execution(phase, true)))).toBe("stop");
      expect(headerSlot(at({ paused: true }, execution(phase)))).toBe("resume");
    }
    for (const phase of ["done", "failed", "stopped"]) {
      expect(isRunning(at({}, execution(phase)))).toBe(false);
      expect(headerSlot(at({}, execution(phase)))).toBe("stop"); // the loop is free: hold it
      expect(headerSlot(at({ stopped: true }, execution(phase)))).toBe("start");
      expect(headerSlot(at({ yielded: true }, execution(phase)))).toBe("start");
      expect(headerSlot(at({ paused: true }, execution(phase)))).toBe("resume");
    }
    expect(headerSlot(at({}))).toBe("stop");
    expect(headerSlot(at({ stopped: true }))).toBe("start");
  });

  test("Stop's tooltip names what it would end", () => {
    expect(stopTitle(at({}, execution("running", true)))).toContain(
      "Ends wordcount e7 (a person's launch)",
    );
    expect(stopTitle(at({ yielded: true }, execution("done")))).toContain("before its next frame");
  });

  test("the activity line says what Stop and Start did (rule R2)", () => {
    const sc = new Script(3);
    sc.startStage(2);
    sc.send({ t: "controlApplied", op: "stop", nodeIds: [] });
    expect(sc.state.activity.at(-1)?.text).toContain("the loop is held until Start");
    expect(sc.state.machine?.stopped).toBe(true);
    sc.send({ t: "controlApplied", op: "start", nodeIds: [] });
    expect(sc.state.activity.at(-1)?.text).toBe("start: the loop runs again");
  });
});
