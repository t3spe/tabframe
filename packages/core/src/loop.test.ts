import { describe, expect, test } from "bun:test";
import { RELEASED } from "@tabframe/protocol";
import {
  HUMAN_RESULT_HOLD_MS,
  KEEP_ENDED_EXECUTIONS,
  KEEP_ENDED_TASKS,
  LOOP_BACKOFF_MAX_MS,
  LOOP_BACKOFF_MIN_MS,
  pruneExecutions,
} from "./executions.ts";
import { BUNDLE, H, harness, renderSpec } from "./harness.ts";
import { adoptLedger, deserializeLedger, serializeLedger } from "./snapshot.ts";

/** The machine's default loop after failures: back off, doubling; success resets (D4, D19). */
describe("default loop backoff", () => {
  test("a failed loop execution pauses the relaunch; the pause doubles; a success resets it", () => {
    const h = harness({ defaultLoop: { bundle: BUNDLE, params: { preset: 0 } } });
    h.subscribe("obs");
    h.hello("a", "h1");
    h.addProgram("tiles"); // programAdded → ensureDefaultLoop launches e1
    const failRunning = (): number => {
      const exec = [...h.ledger.executions.values()].find((e) => e.status === "running");
      if (!exec) throw new Error("nothing running");
      h.tick(); // make sure the plan task is assigned
      const plan = planAssignOf(h, exec.executionId);
      const before = h.now;
      h.resultError(plan.connId, plan.taskId, plan.attempt, "trap: boom");
      expect(exec.status).toBe("failed");
      return h.ledger.meta.loopPausedUntil - before;
    };
    /** Let time pass while the node heartbeats and the observer pings, so neither is dropped. */
    const wait = (ms: number): void => {
      for (let left = ms; left > 0; left -= 1_000) {
        h.advance(Math.min(1_000, left));
        h.heartbeat("a");
        h.send("obs", { t: "ping" });
        h.tick();
      }
    };
    expect(h.ledger.running).not.toBeNull();
    expect(failRunning()).toBe(LOOP_BACKOFF_MIN_MS);
    // Nothing relaunches while paused.
    expect(h.tick().some((e) => e.kind === "send" && e.msg.t === "executionQueued")).toBe(false);
    expect(h.ledger.running).toBeNull();
    wait(LOOP_BACKOFF_MIN_MS - 1_000);
    expect(h.ledger.running).toBeNull(); // still paused
    wait(1_000);
    expect(h.ledger.running).not.toBeNull();
    // The second failure doubles the pause.
    expect(failRunning()).toBe(LOOP_BACKOFF_MIN_MS * 2);
    wait(LOOP_BACKOFF_MIN_MS * 2);
    // A successful execution resets the backoff.
    const exec = [...h.ledger.executions.values()].find((e) => e.status === "running");
    if (!exec) throw new Error("nothing running");
    const plan = planAssignOf(h, exec.executionId);
    const stage = h.planSpec(
      h.result(plan.connId, plan.taskId, plan.attempt, H("e")),
      renderSpec(1),
    );
    const run = h.assigns(stage).find((a) => a.kind === "run");
    if (!run) throw new Error("no run");
    h.manifestStored(h.result(run.connId, run.taskId, run.attempt, H("1")));
    // the folded stage creates the next plan task, whose spec says done
    const next = planAssignOf(h, exec.executionId);
    h.planSpec(h.result(next.connId, next.taskId, next.attempt, H("f")), {
      kind: "done",
      next: null,
    });
    expect(exec.status).toBe("done");
    expect(h.ledger.meta.loopBackoffMs).toBe(0);
    expect(h.invariants()).toEqual([]);
  });

  test("the pause is capped and released results do not count as failures", () => {
    const h = harness({ defaultLoop: { bundle: BUNDLE, params: { preset: 0 } } });
    h.subscribe("obs");
    h.hello("a", "h1");
    h.addProgram("tiles");
    h.ledger.meta.loopBackoffMs = LOOP_BACKOFF_MAX_MS;
    const exec = [...h.ledger.executions.values()][0];
    if (!exec) throw new Error("no execution");
    const plan = planAssignOf(h, exec.executionId);
    h.resultError(plan.connId, plan.taskId, plan.attempt, RELEASED);
    expect(exec.status).toBe("running");
    h.resultError(plan.connId, plan.taskId, plan.attempt + 1, "trap");
    expect(exec.status).toBe("failed");
    expect(h.ledger.meta.loopBackoffMs).toBe(LOOP_BACKOFF_MAX_MS);
  });

  test("human executions never touch the backoff", () => {
    const h = harness({ defaultLoop: { bundle: BUNDLE, params: { preset: 0 } } });
    h.hello("a", "h1");
    h.addProgram("tiles"); // no observer: the loop stays quiet
    h.launch({ preset: 3 }, true);
    const exec = [...h.ledger.executions.values()][0];
    if (!exec) throw new Error("no execution");
    const plan = planAssignOf(h, exec.executionId);
    h.resultError(plan.connId, plan.taskId, plan.attempt, "trap");
    expect(exec.status).toBe("failed");
    expect(h.ledger.meta.loopBackoffMs).toBe(0);
  });

  test("old snapshots without the fields deserialize with zeros", () => {
    const h = harness();
    const json = JSON.parse(serializeLedger(h.ledger)) as { meta: Record<string, unknown> };
    delete json.meta.loopBackoffMs;
    delete json.meta.loopPausedUntil;
    const back = deserializeLedger(JSON.stringify(json));
    expect(back.meta.loopBackoffMs).toBe(0);
    expect(back.meta.loopPausedUntil).toBe(0);
  });
});

describe("pruning ended executions", () => {
  test(`keeps the most recent ${KEEP_ENDED_EXECUTIONS} and drops older ones with their tasks`, () => {
    const h = harness();
    h.hello("a", "h1");
    h.addProgram("tiles");
    for (let i = 0; i < KEEP_ENDED_EXECUTIONS + 5; i++) {
      h.launch({ preset: i }, true);
      const exec = [...h.ledger.executions.values()].find((e) => e.status === "running");
      if (!exec) throw new Error("nothing running");
      const plan = planAssignOf(h, exec.executionId);
      h.advance(10);
      h.resultError(plan.connId, plan.taskId, plan.attempt, "trap");
    }
    expect(h.ledger.executions.size).toBe(KEEP_ENDED_EXECUTIONS + 5);
    const pruned = pruneExecutions(h.ledger);
    expect(pruned.length).toBe(5);
    expect(h.ledger.executions.size).toBe(KEEP_ENDED_EXECUTIONS);
    // The oldest went; every remaining task belongs to a remaining execution.
    expect(h.ledger.executions.has("e1")).toBe(false);
    for (const t of h.ledger.tasks.values())
      expect(h.ledger.executions.has(t.executionId)).toBe(true);
    expect(h.invariants()).toEqual([]);
    // Ticks prune too.
    h.launch({ preset: 99 }, true);
    const exec = [...h.ledger.executions.values()].find((e) => e.status === "running");
    if (!exec) throw new Error("nothing running");
    const plan = planAssignOf(h, exec.executionId);
    h.resultError(plan.connId, plan.taskId, plan.attempt, "trap");
    h.tick();
    expect(h.ledger.executions.size).toBe(KEEP_ENDED_EXECUTIONS);
  });
});

function planAssignOf(h: ReturnType<typeof harness>, executionId: string) {
  const exec = h.ledger.executions.get(executionId);
  const task = exec?.planTaskId ? h.ledger.tasks.get(exec.planTaskId) : undefined;
  const attempt = task?.attempts.find((a) => a.outcome === "running");
  if (!task || !attempt) throw new Error(`no running plan attempt for ${executionId}`);
  const node = h.ledger.nodes.get(attempt.nodeId);
  if (!node) throw new Error("no node");
  return { connId: node.connId, taskId: task.taskId, attempt: attempt.attempt, kind: task.kind };
}

describe("pruning ended executions' tasks", () => {
  test(`only the ${KEEP_ENDED_TASKS} most recent ended executions keep their tasks; records stay; the running one is untouched`, () => {
    const h = harness();
    h.hello("a", "h1");
    h.addProgram("tiles");
    /** Run a three-tile frame to the end: fold the stage, then let its follow-up planner say done. */
    const finish = (preset: number): string => {
      h.launch({ preset }, true);
      h.tick(); // the plan task is assigned on the next fill
      const exec = [...h.ledger.executions.values()].find((e) => e.status === "running");
      if (!exec) throw new Error("nothing running");
      const plan = planAssignOf(h, exec.executionId);
      const stage = h.planSpec(
        h.result(plan.connId, plan.taskId, plan.attempt, H("e")),
        renderSpec(3),
      );
      let pending = h.assigns(stage).filter((a) => a.kind === "run");
      let last: ReturnType<typeof h.result> = stage;
      while (pending.length > 0) {
        const next: typeof pending = [];
        for (const run of pending) {
          last = h.result(run.connId, run.taskId, run.attempt, H("1"));
          next.push(...h.assigns(last).filter((a) => a.kind === "run"));
        }
        pending = next.length > 0 ? next : h.assigns(h.tick()).filter((a) => a.kind === "run");
      }
      h.manifestStored(last, H("f"));
      h.advance(10);
      const again = planAssignOf(h, exec.executionId);
      h.planSpec(h.result(again.connId, again.taskId, again.attempt, H("d")), {
        kind: "done",
        next: null,
      });
      expect(exec.status).toBe("done");
      return exec.executionId;
    };
    const ids = Array.from({ length: KEEP_ENDED_TASKS + 3 }, (_, i) => finish(i));
    const tasksOf = (id: string) =>
      [...h.ledger.tasks.values()].filter((t) => t.executionId === id).length;
    // One more, running, with tasks of its own.
    h.launch({ preset: 99 }, true);
    const running = [...h.ledger.executions.values()].find((e) => e.status === "running");
    if (!running) throw new Error("nothing running");
    const before = tasksOf(running.executionId);

    pruneExecutions(h.ledger);
    const recent = ids.slice(-KEEP_ENDED_TASKS);
    const older = ids.slice(0, -KEEP_ENDED_TASKS);
    expect(recent.every((id) => tasksOf(id) > 0)).toBe(true);
    expect(older.every((id) => tasksOf(id) === 0)).toBe(true);
    // The records are all still there, with what they knew.
    expect(older.every((id) => h.ledger.executions.has(id))).toBe(true);
    expect(h.ledger.executions.get(older[0] as string)?.stageTaskIds.length).toBe(3);
    // The file map goes with the tasks; the root stays, and the recent frames keep their maps.
    expect(h.ledger.executions.get(older[0] as string)?.files).toEqual({});
    expect(h.ledger.executions.get(older[0] as string)?.root).toBe(H("f"));
    expect(
      Object.keys(h.ledger.executions.get(recent[0] as string)?.files ?? {}).length,
    ).toBeGreaterThan(0);
    expect(tasksOf(running.executionId)).toBe(before);
    expect(h.invariants()).toEqual([]);
    // Idempotent: a second pass finds nothing left to drop.
    const tasksNow = h.ledger.tasks.size;
    expect(pruneExecutions(h.ledger)).toEqual([]);
    expect(h.ledger.tasks.size).toBe(tasksNow);
    // A ledger adopted from before the file-map rule: tasks long gone, maps still there. They go.
    const adopted = h.ledger.executions.get(older[1] as string);
    if (!adopted) throw new Error("no record");
    adopted.files = { "/out/0/0": { hash: H("1"), size: 256 } };
    pruneExecutions(h.ledger);
    expect(adopted.files).toEqual({});
  });
});

describe("a person's result holds the stage", () => {
  test("a continuation the previous frame left in the queue waits out the hold too", () => {
    const h = harness({ defaultLoop: { bundle: BUNDLE, params: { preset: 0 } } });
    h.subscribe("obs");
    h.hello("a", "h1");
    h.addProgram("tiles"); // the loop launches e1
    h.tick();
    const loopFrame = [...h.ledger.executions.values()][0];
    if (!loopFrame || loopFrame.human) throw new Error("the loop did not launch");
    h.launch({ preset: 5 }, true); // e2, a person's, queued ahead of continuations
    // e1 ends offering a follow-up: e3 (automatic) joins the queue behind e2, and e2 starts.
    const plan1 = planAssignOf(h, loopFrame.executionId);
    h.planSpec(h.result(plan1.connId, plan1.taskId, plan1.attempt, H("e")), {
      kind: "done",
      next: { preset: 1 },
    });
    const byId = (id: string) => h.ledger.executions.get(id);
    expect(byId("e1")?.status).toBe("done");
    expect(byId("e2")?.status).toBe("running");
    expect(byId("e3")?.human).toBe(false);
    expect(h.ledger.queue).toEqual(["e3"]);
    // e2 ends: e3 does not take the stage until the hold is over.
    h.tick();
    const plan2 = planAssignOf(h, "e2");
    h.planSpec(h.result(plan2.connId, plan2.taskId, plan2.attempt, H("e")), {
      kind: "done",
      next: null,
    });
    expect(byId("e2")?.status).toBe("done");
    expect(h.ledger.running).toBeNull();
    const alive = () => {
      h.heartbeat("a");
      h.send("obs", { t: "ping" });
    };
    for (let t = 0; t < HUMAN_RESULT_HOLD_MS - 1_000; t += 1_000) {
      h.advance(1_000);
      alive();
      h.tick();
    }
    expect(h.ledger.running).toBeNull();
    expect(byId("e3")?.status).toBe("queued");
    h.advance(1_000);
    alive();
    h.tick();
    expect(h.ledger.running).toBe("e3");
  });

  test("the loop waits HUMAN_RESULT_HOLD_MS after a human launch ends before it takes over", () => {
    const h = harness();
    h.subscribe("obs");
    h.hello("a", "h1");
    h.addProgram("tiles");
    h.launch({ preset: 0 }, true);
    h.tick();
    const exec = [...h.ledger.executions.values()][0];
    if (!exec) throw new Error("nothing launched");
    const plan = planAssignOf(h, exec.executionId);
    h.planSpec(h.result(plan.connId, plan.taskId, plan.attempt, H("e")), {
      kind: "done",
      next: null,
    });
    expect(exec.status).toBe("done");
    // The loop is configured only now, so the hold is the only thing keeping it back. The node
    // and the observer keep talking, or the silence window would empty the machine first.
    h.ledger.config.defaultLoop = { bundle: BUNDLE, params: { preset: 1 } };
    const alive = () => {
      h.heartbeat("a");
      h.send("obs", { t: "ping" });
    };
    for (let t = 0; t < HUMAN_RESULT_HOLD_MS - 1_000; t += 1_000) {
      h.advance(1_000);
      alive();
      h.tick();
    }
    expect(h.ledger.executions.size).toBe(1);
    h.advance(1_000);
    alive();
    h.tick();
    expect(h.ledger.executions.size).toBe(2);
    expect([...h.ledger.executions.values()][1]?.human).toBe(false);
  });
});

/** A person pressed Stop (WP6.1): the machine goes idle and stays idle until Start. */
describe("stop and start", () => {
  const alive = (h: ReturnType<typeof harness>) => {
    h.heartbeat("a");
    h.send("obs", { t: "ping" });
  };
  test("stop ends the running frame, drops the loop's queued continuation, keeps a person's launch, and holds the loop", () => {
    const h = harness({ defaultLoop: { bundle: BUNDLE, params: { preset: 0 } } });
    h.subscribe("obs");
    h.hello("a", "h1");
    h.addProgram("tiles"); // the loop launches e1
    h.tick();
    expect(h.ledger.running).toBe("e1");
    // A queued continuation and a queued human launch.
    h.event({ kind: "launch", bundle: BUNDLE, params: { preset: 3 }, human: false, inherit: null });
    h.launch({ preset: 7 }, true);
    expect(h.ledger.queue).toEqual(["e3", "e2"]);
    const effects = h.send("obs", { t: "stop" });
    expect(
      effects.some((e) => e.kind === "send" && e.msg.t === "controlApplied" && e.msg.op === "stop"),
    ).toBe(true);
    expect(h.ledger.meta.loopStopped).toBe(true);
    expect(h.ledger.executions.get("e1")?.status).toBe("cancelled");
    expect(h.ledger.executions.get("e2")?.status).toBe("cancelled"); // the loop's continuation
    // The person's launch was next in line and runs; the loop does not follow it.
    expect(h.ledger.running).toBe("e3");
    const plan = planAssignOf(h, "e3");
    h.planSpec(h.result(plan.connId, plan.taskId, plan.attempt, H("e")), {
      kind: "done",
      next: { preset: 8 },
    });
    expect(h.ledger.executions.get("e3")?.status).toBe("done");
    for (let i = 0; i < 30; i++) {
      h.advance(1_000);
      alive(h);
      h.tick();
    }
    expect(h.ledger.running).toBeNull();
    expect(h.ledger.queue).toEqual([]);
    // The snapshot says so, and a snapshot round trip keeps it.
    const snap = h.subscribe("late").find((e) => e.kind === "send" && e.msg.t === "snapshot");
    if (snap?.kind !== "send" || snap.msg.t !== "snapshot") throw new Error("no snapshot");
    expect(snap.msg.machine?.stopped).toBe(true);
    expect(deserializeLedger(serializeLedger(h.ledger)).meta.loopStopped).toBe(true);
    expect(h.invariants()).toEqual([]);
  });

  test("start lets the loop run again at once, hold or backoff notwithstanding", () => {
    const h = harness({ defaultLoop: { bundle: BUNDLE, params: { preset: 0 } } });
    h.subscribe("obs");
    h.hello("a", "h1");
    h.addProgram("tiles");
    h.tick();
    h.send("obs", { t: "stop" });
    expect(h.ledger.running).toBeNull();
    h.ledger.meta.loopPausedUntil = h.now + 60_000; // as after a person's launch, or a failure
    const effects = h.send("obs", { t: "start" });
    expect(
      effects.some(
        (e) => e.kind === "send" && e.msg.t === "controlApplied" && e.msg.op === "start",
      ),
    ).toBe(true);
    expect(h.ledger.meta.loopStopped).toBe(false);
    expect(h.ledger.running).not.toBeNull();
    expect(h.ledger.executions.get(h.ledger.running as string)?.human).toBe(false);
    expect(h.invariants()).toEqual([]);
  });

  test("stop with nothing running is just the hold; a person's launch still runs while stopped", () => {
    const h = harness();
    h.subscribe("obs");
    h.hello("a", "h1");
    h.addProgram("tiles");
    h.send("obs", { t: "stop" });
    expect(h.ledger.meta.loopStopped).toBe(true);
    h.launch({ preset: 1 }, true);
    expect(h.ledger.running).toBe("e1");
    expect(h.invariants()).toEqual([]);
  });
});

/** An editor tab holds the machine paused (WP6.4): nothing new is assigned or started. */
describe("pause and resume", () => {
  test("pause freezes assignment and starts; resume continues the same execution", () => {
    const h = harness();
    h.subscribe("obs");
    h.hello("a", "h1");
    h.addProgram("tiles");
    h.launch({ preset: 0 }, true);
    h.tick();
    const plan = planAssignOf(h, "e1");
    h.connect("editor", "observer");
    h.send("editor", { t: "subscribe" });
    const paused = h.send("editor", { t: "pause" });
    expect(
      paused.some((e) => e.kind === "send" && e.msg.t === "controlApplied" && e.msg.op === "pause"),
    ).toBe(true);
    expect(h.ledger.meta.pausedBy).toBe("editor");
    // The plan result lands and the stage is created, but no tile is handed out.
    const stage = h.planSpec(
      h.result(plan.connId, plan.taskId, plan.attempt, H("e")),
      renderSpec(3),
    );
    expect(h.assigns(stage)).toEqual([]);
    expect(h.assigns(h.tick())).toEqual([]);
    expect(h.ledger.running).toBe("e1");
    // A second pause from the same tab is one pause; the snapshot says paused.
    expect(h.send("editor", { t: "pause" })).toEqual([]);
    const snap = h.subscribe("late").find((e) => e.kind === "send" && e.msg.t === "snapshot");
    if (snap?.kind !== "send" || snap.msg.t !== "snapshot") throw new Error("no snapshot");
    expect(snap.msg.machine?.paused).toBe(true);
    // Resume from the dashboard: the tiles go out at once.
    const resumed = h.send("obs", { t: "resume" });
    expect(h.ledger.meta.pausedBy).toBeNull();
    expect(h.assigns(resumed).length).toBeGreaterThan(0);
    expect(h.invariants()).toEqual([]);
  });

  test("the holder's socket going away lifts the pause; adoption clears it too", () => {
    const h = harness({ defaultLoop: { bundle: BUNDLE, params: { preset: 0 } } });
    h.subscribe("obs");
    h.hello("a", "h1");
    h.connect("editor", "observer");
    h.send("editor", { t: "subscribe" });
    h.send("editor", { t: "pause" });
    h.addProgram("tiles"); // the loop would launch now; it waits
    h.tick();
    expect(h.ledger.running).toBeNull();
    const gone = h.disconnect("editor");
    expect(
      gone.some((e) => e.kind === "send" && e.msg.t === "controlApplied" && e.msg.op === "resume"),
    ).toBe(true);
    expect(h.ledger.meta.pausedBy).toBeNull();
    expect(h.ledger.running).not.toBeNull();
    // A pause never survives a rotation: the holder is on the previous generation's sockets.
    h.connect("editor2", "observer");
    h.send("editor2", { t: "subscribe" });
    h.send("editor2", { t: "pause" });
    expect(h.ledger.meta.pausedBy).toBe("editor2");
    const restored = deserializeLedger(serializeLedger(h.ledger));
    expect(restored.meta.pausedBy).toBeNull();
    adoptLedger(h.ledger, 9, h.now);
    expect(h.ledger.meta.pausedBy).toBeNull();
    expect(h.invariants()).toEqual([]);
  });
});
