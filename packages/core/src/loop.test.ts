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
import { deserializeLedger, serializeLedger } from "./snapshot.ts";

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
