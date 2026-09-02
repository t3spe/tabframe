import { describe, expect, test } from "bun:test";
import { RELEASED } from "@tabframe/protocol";
import { harness, renderSpec } from "./harness.ts";

/** A node that gave up on a task (its own deadline) releases the attempt; the task is not judged. */
describe("released results", () => {
  test("the task goes back to the front, nothing fails, and another node picks it up", () => {
    const h = harness();
    h.subscribe("obs");
    h.hello("a", "h1");
    h.hello("b", "h2");
    h.addProgram();
    const launched = h.launch();
    const planAssign = h.assigns(launched)[0];
    if (!planAssign) throw new Error("no plan assign");
    const stageEffects = h.planSpec(
      h.result(planAssign.connId, planAssign.taskId, planAssign.attempt, "e".repeat(64)),
      renderSpec(3),
    );
    const runs = h.assigns(stageEffects).filter((a) => a.kind === "run");
    expect(runs.length).toBeGreaterThan(0);
    const victim = runs[0] as { connId: string; taskId: string; attempt: number };
    const exec = [...h.ledger.executions.values()][0];
    if (!exec) throw new Error("no execution");
    const failedBefore = exec.counters.failed;
    const doneBefore = [...h.ledger.nodes.values()].reduce((n, node) => n + node.tasksDone, 0);

    const effects = h.resultError(victim.connId, victim.taskId, victim.attempt, RELEASED);
    const task = h.ledger.tasks.get(victim.taskId);
    if (!task) throw new Error("no task");
    expect(task.status === "pending" || task.status === "assigned").toBe(true);
    expect(exec.counters.failed).toBe(failedBefore);
    const attempt = task.attempts.find((a) => a.attempt === victim.attempt);
    expect(attempt?.outcome).toBe("released");
    // Giving up is not a completed task in the node's statistics.
    const doneAfter = [...h.ledger.nodes.values()].reduce((n, node) => n + node.tasksDone, 0);
    expect(doneAfter).toBe(doneBefore);
    // Announced as a reassignment, then refilled in the same step: a fresh attempt exists.
    expect(
      effects.some(
        (e) => e.kind === "send" && e.msg.t === "taskReassigned" && e.msg.taskId === victim.taskId,
      ),
    ).toBe(true);
    expect(h.assigns(effects).some((a) => a.taskId === victim.taskId)).toBe(true);
    expect(task.attempts.length).toBe(2);
    expect(runningAttemptsOf(task)).toBe(1);
    expect(h.invariants()).toEqual([]);
  });
});

function runningAttemptsOf(task: { attempts: Array<{ outcome: string }> }): number {
  return task.attempts.filter((a) => a.outcome === "running").length;
}
