import { describe, expect, test } from "bun:test";
import {
  ACTIVITY_CAP,
  applyMessage,
  emptyState,
  FLASH_MS,
  HISTORY_CAP,
  PULSE_CAP,
  withRedundancy,
} from "./cluster-state.ts";
import { env, executionView, HASH, node, Script, snapshot, taskView } from "./fixtures.ts";
import {
  hostCount,
  inFlightByNode,
  isFlashing,
  planTask,
  programList,
  progress,
  stageTasks,
  taskColor,
} from "./selectors.ts";

describe("cluster state: snapshots and sequence", () => {
  test("snapshot pages accumulate nodes and tasks, then complete", () => {
    let s = emptyState();
    s = applyMessage(
      s,
      snapshot(10, {
        pages: 2,
        nodes: [node("n1")],
        programs: undefined,
        execution: executionView({ taskCount: 3 }),
        queue: [{ executionId: "e2", programName: "wordcount", human: true, queuedAt: 3 }],
        machine: { awake: true, reason: null, redundancy: true, nextRotationAt: null, uptimeMs: 1 },
        tasks: [taskView("t1", 0), taskView("t2", 1)],
        at: 5,
      }),
    );
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
  test("the loop's yield and its return are announced", () => {
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
    const s = applyMessage(
      sc.state,
      snapshot(40, { nodes: [node("n9")], programs: undefined, machine: undefined, at: 0 }),
    );
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
    expect(taskColor(sc.task("t1"))).toBe("assigned");
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
    const t1 = sc.task("t1");
    expect(t1.status).toBe("done");
    expect(t1.output).toBe(HASH);
    expect(t1.holders).toEqual([]);
    expect(t1.computeMs).toBe(420);
    expect(taskColor(t1)).toBe("done");
    expect(sc.state.nodes.get("n1")).toMatchObject({ tasksDone: 1, lastTaskMs: 420 });
    expect(inFlightByNode(sc.state).get("n1")).toBeUndefined();
    expect(progress(sc.state)).toEqual({ done: 1, total: 2 });
    // A done event for a task never assigned (the dashboard missed it) still counts once.
    sc.send({ t: "taskDone", taskId: "t2", nodeId: "n2", output: HASH, place: null, computeMs: 5 });
    expect(sc.state.execution?.counters).toMatchObject({ pending: 0, assigned: 0, done: 2 });
    expect(sc.task("t2").place).toEqual({ x: 64, y: 0, w: 64, h: 64 });
  });
  test("reassignment releases the task, flashes it, and counts once per release", () => {
    const sc = new Script();
    sc.startStage(1);
    sc.send({ t: "taskAssigned", taskId: "t1", nodeId: "n1", attempt: 1 });
    sc.send({ t: "taskReassigned", taskId: "t1", fromNode: "n1" });
    const t = sc.task("t1");
    expect(t.status).toBe("pending");
    expect(t.holders).toEqual([]);
    expect(isFlashing(t.flashAt, sc.now)).toBe(true);
    expect(isFlashing(t.flashAt, sc.now + FLASH_MS)).toBe(false);
    expect(sc.state.execution?.counters).toMatchObject({ pending: 1, assigned: 0, reassigned: 1 });
    expect(sc.state.activity.at(-1)?.text).toContain("taken back from n1");
    // A twin's release while the other holder keeps running is not a reassignment.
    sc.send({ t: "taskAssigned", taskId: "t1", nodeId: "n2", attempt: 2 });
    sc.send({ t: "taskSpeculated", taskId: "t1", nodeId: "n1" });
    expect(taskColor(sc.task("t1"))).toBe("speculated");
    expect(sc.state.execution?.counters.speculated).toBe(1);
    sc.send({ t: "taskReassigned", taskId: "t1", fromNode: "n1" });
    expect(sc.task("t1").status).toBe("assigned");
    expect(sc.task("t1").holders).toEqual(["n2"]);
    expect(sc.state.execution?.counters.reassigned).toBe(1);
    expect(sc.task("t1").attempts).toBe(3);
  });
  test("speculation, verification, mismatch retraction, and the majority vote", () => {
    const sc = new Script();
    sc.startStage(1);
    sc.send({ t: "taskAssigned", taskId: "t1", nodeId: "n1", attempt: 1 });
    sc.send({ t: "taskSpeculated", taskId: "t1", nodeId: "n2" });
    expect(sc.task("t1").holders).toEqual(["n1", "n2"]);
    expect(inFlightByNode(sc.state)).toEqual(
      new Map([
        ["n1", 1],
        ["n2", 1],
      ]),
    );
    sc.send({ t: "taskDone", taskId: "t1", nodeId: "n2", output: HASH, place: null, computeMs: 9 });
    sc.send({ t: "taskVerified", taskId: "t1", nodeId: "n1" });
    let t = sc.task("t1");
    expect(t.verified).toBe(true);
    expect(taskColor(t)).toBe("verified");
    expect(sc.state.execution?.counters).toMatchObject({ done: 1, verified: 1, speculated: 1 });
    expect(sc.state.nodes.get("n1")?.tasksDone).toBe(1);
    // A third result disagrees: the tile is withdrawn and the task goes back to pending, contested.
    sc.send({ t: "taskMismatch", taskId: "t1", nodeId: "n3" });
    t = sc.task("t1");
    expect(t.status).toBe("pending");
    expect(t.output).toBeNull();
    expect(t.contested).toBe(true);
    expect(t.verified).toBe(false);
    expect(taskColor(t)).toBe("mismatch");
    expect(isFlashing(t.flashAt, sc.now)).toBe(true);
    expect(sc.state.execution?.counters).toMatchObject({ done: 0, pending: 1, mismatched: 1 });
    expect(sc.state.activity.at(-1)?.text).toContain("results disagree");
    // Verification of a task the dashboard never saw only counts.
    sc.send({ t: "taskVerified", taskId: "ghost", nodeId: "n1" });
    expect(sc.state.tasks.has("ghost")).toBe(false);
    expect(sc.state.execution?.counters.verified).toBe(2);
    // The recompute settles by vote: done again, still marked contested.
    sc.send({ t: "taskAssigned", taskId: "t1", nodeId: "n2", attempt: 4 });
    sc.send({ t: "taskDone", taskId: "t1", nodeId: "n2", output: HASH, place: null, computeMs: 9 });
    t = sc.task("t1");
    expect(t.status).toBe("done");
    expect(t.contested).toBe(true);
    expect(taskColor(t)).toBe("done");
  });
  test("a mismatch on an assigned task and on a failed task keeps the counters sane", () => {
    const sc = new Script();
    sc.startStage(2);
    sc.send({ t: "taskAssigned", taskId: "t1", nodeId: "n1", attempt: 1 });
    sc.send({ t: "taskMismatch", taskId: "t1", nodeId: "n1" });
    expect(sc.state.execution?.counters).toMatchObject({ pending: 2, assigned: 0, mismatched: 1 });
    sc.send({ t: "taskAssigned", taskId: "t2", nodeId: "n2", attempt: 1 });
    sc.send({ t: "taskFailed", taskId: "t2", reason: "trap" });
    expect(sc.task("t2")).toMatchObject({
      status: "failed",
      failure: "trap",
      holders: [],
    });
    expect(taskColor(sc.task("t2"))).toBe("failed");
    expect(sc.state.execution?.counters).toMatchObject({ pending: 1, assigned: 0, failed: 1 });
    // A mismatch on a failed task changes nothing: the core never sends one, and counting it would
    // make the task pending and failed at once.
    sc.send({ t: "taskMismatch", taskId: "t2", nodeId: "n2" });
    expect(sc.state.execution?.counters).toMatchObject({ pending: 1, failed: 1, mismatched: 1 });
    sc.send({ t: "taskFailed", taskId: "t9", reason: "never assigned" });
    expect(sc.state.execution?.counters).toMatchObject({ pending: 0, failed: 2 });
  });
  test("rows the stage event could not carry are placed from their ids; odd ids stay unplaced", () => {
    const sc = new Script();
    sc.startStage(300, 256);
    expect(sc.state.execution?.idBase).toBe(1);
    sc.send({ t: "taskAssigned", taskId: "t300", nodeId: "n1", attempt: 1 });
    expect(sc.task("t300").index).toBe(299);
    expect(sc.task("t300").kind).toBe("run");
    sc.send({ t: "taskAssigned", taskId: "t900", nodeId: "n1", attempt: 1 });
    expect(sc.task("t900").index).toBe(-1);
    sc.send({ t: "taskAssigned", taskId: "weird", nodeId: "n1", attempt: 1 });
    expect(sc.task("weird").index).toBe(-1);
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
    expect(sc.task("t3").index).toBe(-1);
  });
  test("task events before any execution still track the task without counters", () => {
    const sc = new Script();
    sc.send({ t: "taskAssigned", taskId: "t5", nodeId: "n1", attempt: 1 });
    expect(sc.task("t5").status).toBe("assigned");
    expect(sc.state.execution).toBeNull();
    expect(stageTasks(sc.state)).toEqual([]);
    expect(progress(sc.state)).toEqual({ done: 0, total: 0 });
  });
});

describe("cluster state: controls and system events", () => {
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
    const s = applyMessage(
      sc.state,
      snapshot(sc.seq, {
        programs: undefined,
        execution: undefined,
        queue: undefined,
        machine: { awake: true, reason: null, redundancy: true, nextRotationAt: null, uptimeMs: 9 },
        at: 0,
      }),
    );
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
  test("the control's echo flips the machine's stopped flag without a refresh", () => {
    let s = applyMessage(
      emptyState(),
      snapshot(1, {
        machine: {
          awake: true,
          reason: null,
          redundancy: false,
          stopped: false,
          nextRotationAt: null,
          uptimeMs: 1,
        },
      }),
    );
    s = applyMessage(s, { t: "controlApplied", ...env, seq: 2, op: "stop", nodeIds: [] });
    expect(s.machine?.stopped).toBe(true);
    expect(s.refresh).toBe(false);
    expect(s.activity.at(-1)?.text).toContain("stop: the loop is held until Start");
    s = applyMessage(s, { t: "controlApplied", ...env, seq: 3, op: "start", nodeIds: [] });
    expect(s.machine?.stopped).toBe(false);
    // Pause and resume the same way.
    s = applyMessage(s, { t: "controlApplied", ...env, seq: 4, op: "pause", nodeIds: [] });
    expect(s.machine?.paused).toBe(true);
    s = applyMessage(s, { t: "controlApplied", ...env, seq: 5, op: "resume", nodeIds: [] });
    expect(s.machine?.paused).toBe(false);
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

describe("cluster state: programs, stages, attempts, failures", () => {
  test("programs come from the snapshot with their views; programAdded fills in the rest", () => {
    let s = applyMessage(
      emptyState(),
      snapshot(1, {
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
      }),
    );
    expect(programList(s).map((p) => p.name)).toEqual(["mandelbrot"]);
    expect(programList(s)[0]?.source).toBeNull(); // the snapshot named none
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

  test("a snapshot mid-execution knows the current stage and that earlier ones happened", () => {
    const s = applyMessage(
      emptyState(),
      snapshot(1, {
        programs: undefined,
        execution: executionView({ stage: 2, stageName: "merge", taskCount: 1 }),
        tasks: [taskView("t9", 0, { stage: 2, status: "done", output: HASH, place: null })],
      }),
    );
    const stages = s.execution?.stages ?? [];
    expect(stages.map((st) => st.known)).toEqual([false, false, true]);
    expect(stages[2]).toMatchObject({ name: "merge", taskCount: 1, done: 1, status: "running" });
  });

  test("a task's history follows its attempts: twins, releases, retractions, failures", () => {
    const sc = new Script();
    sc.startStage(2);
    sc.send({ t: "taskAssigned", taskId: "t1", nodeId: "n1", attempt: 1 });
    sc.send({ t: "taskSpeculated", taskId: "t1", nodeId: "n2" });
    let t1 = sc.task("t1");
    expect(t1.history.map((a) => [a.attempt, a.nodeId, a.speculative, a.outcome])).toEqual([
      [1, "n1", false, "running"],
      [2, "n2", true, "running"],
    ]);
    // n2 answers first: its attempt is done, n1's is cancelled by the core.
    sc.send({ t: "taskDone", taskId: "t1", nodeId: "n2", output: HASH, place: null, computeMs: 7 });
    t1 = sc.task("t1");
    expect(t1.history.map((a) => a.outcome)).toEqual(["cancelled", "done"]);
    expect(t1.history[1]?.computeMs).toBe(7);
    // A late duplicate from n1 agrees: verified, recorded even though its attempt was closed.
    sc.send({ t: "taskVerified", taskId: "t1", nodeId: "n1" });
    expect(sc.task("t1").history.at(-1)).toMatchObject({
      nodeId: "n1",
      outcome: "verified",
    });
    // The other task: taken back, then a lying twin forces a retraction, then it fails.
    sc.send({ t: "taskAssigned", taskId: "t2", nodeId: "n1", attempt: 1 });
    sc.send({ t: "taskReassigned", taskId: "t2", fromNode: "n1" });
    expect(sc.task("t2").history[0]?.outcome).toBe("released");
    sc.send({ t: "taskAssigned", taskId: "t2", nodeId: "n2", attempt: 2 });
    sc.send({ t: "taskDone", taskId: "t2", nodeId: "n2", output: HASH, place: null, computeMs: 4 });
    sc.send({ t: "taskMismatch", taskId: "t2", nodeId: "n1" });
    const t2 = sc.task("t2");
    expect(t2.history.map((a) => [a.nodeId, a.outcome])).toEqual([
      ["n1", "released"],
      ["n2", "retracted"],
      ["n1", "mismatch"],
    ]);
    sc.send({ t: "taskAssigned", taskId: "t2", nodeId: "n2", attempt: 3 });
    sc.send({ t: "taskFailed", taskId: "t2", reason: "trap: unreachable" });
    expect(sc.task("t2").history.at(-1)?.outcome).toBe("failed");
    expect(sc.task("t2").failure).toBe("trap: unreachable");
    expect(sc.state.execution?.stages[0]).toMatchObject({ done: 1, failed: 1 });
  });

  test("history is capped and a snapshot row reconstructs running attempts from its holders", () => {
    const sc = new Script();
    sc.startStage(1);
    for (let i = 1; i <= HISTORY_CAP + 4; i++) {
      sc.send({ t: "taskAssigned", taskId: "t1", nodeId: `n${i}`, attempt: i });
      sc.send({ t: "taskReassigned", taskId: "t1", fromNode: `n${i}` });
    }
    const t1 = sc.task("t1");
    expect(t1.history).toHaveLength(HISTORY_CAP);
    expect(t1.history.at(-1)?.attempt).toBe(HISTORY_CAP + 4);
    const s = applyMessage(
      emptyState(),
      snapshot(1, {
        programs: undefined,
        execution: executionView({ taskCount: 1 }),
        tasks: [taskView("t1", 0, { status: "assigned", holders: ["n1", "n2"], attempts: 3 })],
      }),
    );
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
    expect(sc.task("t1").log).toEqual({ text: "64 rows" });
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

  test("a stop is a phase of its own, with no failure box; a snapshot after one agrees", () => {
    const sc = new Script();
    sc.startStage(1);
    sc.send({ t: "executionFailed", executionId: "e1", reason: "stopped by a person" });
    expect(sc.state.execution?.phase).toBe("stopped");
    expect(sc.state.execution?.failure).toBeNull();
    expect(sc.state.lastFailure).toBeNull();
    const s = applyMessage(
      emptyState(),
      snapshot(1, {
        execution: executionView({ status: "cancelled", failure: "stopped by a person" }),
      }),
    );
    expect(s.execution?.phase).toBe("stopped");
    expect(s.lastFailure).toBeNull();
    const failed = applyMessage(
      emptyState(),
      snapshot(1, { execution: executionView({ status: "failed", failure: "trap" }) }),
    );
    expect(failed.execution?.phase).toBe("failed");
    expect(failed.execution?.failure).toBe("trap");
    expect(failed.lastFailure?.reason).toBe("trap");
  });
});

describe("cluster state: flashes and pulses", () => {
  test("every event that moves a task flashes it with its kind and leaves a pulse", () => {
    const sc = new Script();
    sc.startStage(2);
    sc.send({ t: "taskAssigned", taskId: "t1", nodeId: "n1", attempt: 1 });
    expect(sc.task("t1").flashKind).toBeNull();
    sc.send({ t: "taskReassigned", taskId: "t1", fromNode: "n1" });
    let t1 = sc.task("t1");
    expect(t1).toMatchObject({ status: "pending", released: true, flashKind: "released" });
    expect(taskColor(t1)).toBe("released");
    expect(sc.state.pulses.at(-1)).toMatchObject({
      taskId: "t1",
      kind: "released",
      nodeId: "n1",
      at: sc.now,
    });
    // Handed out again: the colour follows the holder; the kind stays as the last thing that happened.
    sc.send({ t: "taskAssigned", taskId: "t1", nodeId: "n2", attempt: 2 });
    t1 = sc.task("t1");
    expect(t1.released).toBe(false);
    expect(taskColor(t1)).toBe("assigned");
    expect(t1.flashKind).toBe("released");
    sc.send({ t: "taskSpeculated", taskId: "t1", nodeId: "n1" });
    expect(sc.task("t1").flashKind).toBe("speculated");
    expect(isFlashing(sc.task("t1").flashAt, sc.now)).toBe(true);
    sc.send({ t: "taskDone", taskId: "t1", nodeId: "n2", output: HASH, place: null, computeMs: 3 });
    expect(sc.task("t1").settledAt).toBe(sc.now);
    sc.send({ t: "taskVerified", taskId: "t1", nodeId: "n1" });
    expect(sc.task("t1").flashKind).toBe("verified");
    sc.send({ t: "taskMismatch", taskId: "t1", nodeId: "n3" });
    expect(sc.task("t1")).toMatchObject({
      flashKind: "mismatch",
      released: false,
      settledAt: null,
    });
    expect(taskColor(sc.task("t1"))).toBe("mismatch");
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
    expect(sc.task("t2")).toMatchObject({ status: "assigned", released: false });
    expect(taskColor(sc.task("t2"))).toBe("assigned");
  });
});
