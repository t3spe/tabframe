import { describe, expect, test } from "bun:test";
import {
  applyMessage,
  CHART_WINDOW_MS,
  emptyState,
  THROUGHPUT_WINDOW_MS,
} from "./cluster-state.ts";
import { at, execution, executionView, HASH, Script, snapshot, taskView } from "./fixtures.ts";
import {
  headerSlot,
  isRunning,
  latestControl,
  ledgerRows,
  loopState,
  machineBanner,
  rotationCountdown,
  stageStrip,
  throughput,
  throughputSeries,
  visibleActivity,
} from "./selectors.ts";

describe("the header's one slot and the loop's state", () => {
  test("the loop's state reads paused, held, yielded, running, in that order of precedence", () => {
    expect(loopState(at({}))).toBe("running");
    expect(loopState(at({ stopped: true }))).toBe("held");
    expect(loopState(at({ yielded: true }))).toBe("yielded");
    expect(loopState(at({ stopped: true, yielded: true }))).toBe("held");
    expect(loopState(at({ paused: true, stopped: true }))).toBe("paused");
    expect(loopState({ ...emptyState(), machine: null })).toBe("running");
  });

  test("the slot follows what a visitor can do now: Stop while anything runs, Start when idle and held", () => {
    for (const phase of ["planning", "running", "folding"] as const) {
      expect(isRunning(at({}, execution(phase)))).toBe(true);
      expect(headerSlot(at({}, execution(phase)))).toBe("stop");
      expect(headerSlot(at({ stopped: true }, execution(phase, { human: true })))).toBe("stop");
      expect(headerSlot(at({ yielded: true }, execution(phase, { human: true })))).toBe("stop");
      expect(headerSlot(at({ paused: true }, execution(phase)))).toBe("resume");
    }
    for (const phase of ["done", "failed", "stopped"] as const) {
      expect(isRunning(at({}, execution(phase)))).toBe(false);
      expect(headerSlot(at({}, execution(phase)))).toBe("stop"); // the loop is free: hold it
      expect(headerSlot(at({ stopped: true }, execution(phase)))).toBe("start");
      expect(headerSlot(at({ yielded: true }, execution(phase)))).toBe("start");
      expect(headerSlot(at({ paused: true }, execution(phase)))).toBe("resume");
    }
    expect(headerSlot(at({}))).toBe("stop");
    expect(headerSlot(at({ stopped: true }))).toBe("start");
  });
});

describe("throughput and the chart", () => {
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
});

describe("the machine banner and the rotation countdown", () => {
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
      snapshot(sc.seq, {
        programs: undefined,
        execution: undefined,
        queue: undefined,
        machine: {
          awake: false,
          reason: "an hour without anyone touching the dashboard",
          redundancy: false,
          nextRotationAt: null,
          uptimeMs: 1,
        },
        at: 0,
      }),
      sc.now,
    );
    expect(asleep.sleeping).toBeNull();
    expect(machineBanner(asleep, sc.now)).toEqual({
      kind: "asleep",
      reason: "an hour without anyone touching the dashboard",
    });
    expect(machineBanner({ ...asleep, machine: null }, sc.now)).toBeNull();
  });
});

describe("the ledger", () => {
  test("lists settled tasks newest first with their hashes and tile sizes", () => {
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

describe("the stage strip", () => {
  test("a plan step, then stages with tallies and roots, then done", () => {
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
});

describe("the activity snippet", () => {
  test("the latest control line of the last minute keeps its place under a flood of task lines", () => {
    const sc = new Script();
    sc.startStage(40);
    sc.send({ t: "controlApplied", op: "killHalf", nodeIds: ["n2"] });
    const control = sc.state.activity.at(-1);
    for (let i = 1; i <= 20; i++) {
      sc.send({ t: "taskAssigned", taskId: `t${i}`, nodeId: "n1", attempt: 1 }, 100);
      sc.send({ t: "taskReassigned", taskId: `t${i}`, fromNode: "n1" }, 100);
    }
    expect(latestControl(sc.state, sc.now)).toBe(control ?? null);
    const snippet = visibleActivity(sc.state, sc.now);
    expect(snippet).toHaveLength(14);
    expect(snippet[0]).toBe(control);
    expect(snippet.slice(1).every((a) => a.kind === "task")).toBe(true);
    // A panel tab shows everything, in order.
    expect(visibleActivity(sc.state, sc.now, true)).toEqual(sc.state.activity);
    // A control older than a minute is not held on to.
    expect(latestControl(sc.state, sc.now + 61_000)).toBeNull();
    expect(visibleActivity(sc.state, sc.now + 61_000)).toEqual(sc.state.activity.slice(-14));
  });
});
