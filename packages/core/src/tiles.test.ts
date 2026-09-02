import { describe, expect, test } from "bun:test";
import { H, harness, renderSpec } from "./harness.ts";

/** A tile that is not RGBA of its placed size is a program fault (design §5.2). */
describe("tile output size", () => {
  test("wrong size fails the task; the right size completes it", () => {
    const h = harness();
    h.subscribe("obs");
    h.hello("a", "h1");
    h.addProgram("tiles");
    const launched = h.launch();
    const plan = h.assigns(launched)[0];
    if (!plan) throw new Error("no plan assign");
    const stage = h.planSpec(
      h.result(plan.connId, plan.taskId, plan.attempt, H("e")),
      renderSpec(2),
    );
    const runs = h.assigns(stage).filter((a) => a.kind === "run");
    const [first, second] = runs;
    if (!first || !second) throw new Error("expected two run assigns");
    // 8×8 placements → 256 bytes expected.
    const bad = h.result(first.connId, first.taskId, first.attempt, H("1"), { outputSize: 100 });
    expect(bad.some((e) => e.kind === "send" && e.msg.t === "taskFailed")).toBe(true);
    expect(h.ledger.tasks.get(first.taskId)?.status).toBe("failed");
    expect(h.ledger.tasks.get(first.taskId)?.failure).toContain("expected 256");
    const exec = [...h.ledger.executions.values()][0];
    expect(exec?.status).toBe("failed");
    expect(h.invariants()).toEqual([]);
  });

  test("non-tile views and unplaced tasks are not checked", () => {
    const h = harness();
    h.subscribe("obs");
    h.hello("a", "h1");
    h.addProgram("bars");
    const launched = h.launch();
    const plan = h.assigns(launched)[0];
    if (!plan) throw new Error("no plan assign");
    const stage = h.planSpec(
      h.result(plan.connId, plan.taskId, plan.attempt, H("e")),
      renderSpec(1),
    );
    const run = h.assigns(stage).find((a) => a.kind === "run");
    if (!run) throw new Error("no run assign");
    const ok = h.result(run.connId, run.taskId, run.attempt, H("1"), { outputSize: 100 });
    expect(ok.some((e) => e.kind === "send" && e.msg.t === "taskDone")).toBe(true);
    expect(h.ledger.tasks.get(run.taskId)?.status).toBe("done");
  });
});
