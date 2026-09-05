import { describe, expect, test } from "bun:test";
import { H, harness } from "./harness.ts";
import { KEEP_ENDED_EXECUTIONS, KEEP_ENDED_TASKS } from "./policy.ts";
import { pruneExecutions } from "./retention.ts";

/** Pruning (design §9.4): ended executions and their tasks past the depths the ledger keeps. */

describe("pruning ended executions", () => {
  test(`keeps the most recent ${KEEP_ENDED_EXECUTIONS} and drops older ones with their tasks`, () => {
    const h = harness();
    h.hello("a", "h1");
    h.addProgram("tiles");
    for (let i = 0; i < KEEP_ENDED_EXECUTIONS + 5; i++) {
      h.launch({ preset: i }, true);
      const exec = [...h.ledger.executions.values()].find((e) => e.status === "running");
      if (!exec) throw new Error("nothing running");
      const plan = h.planAssign(exec.executionId);
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
    const plan = h.planAssign(exec.executionId);
    h.resultError(plan.connId, plan.taskId, plan.attempt, "trap");
    h.tick();
    expect(h.ledger.executions.size).toBe(KEEP_ENDED_EXECUTIONS);
  });
});

describe("pruning ended executions' tasks", () => {
  test(`only the ${KEEP_ENDED_TASKS} most recent ended executions keep their tasks; records stay; the running one is untouched`, () => {
    const h = harness();
    h.hello("a", "h1");
    h.addProgram("tiles");
    /** Run a three-tile frame to the end, ten milliseconds after the last one. */
    const finish = (preset: number): string => {
      h.launch({ preset }, true);
      h.tick(); // the plan task is assigned on the next fill
      h.advance(10);
      return h.completeFrame(H("f"), { tasks: 3 }).executionId;
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
