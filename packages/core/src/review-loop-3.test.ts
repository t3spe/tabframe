// The third review loop's core rules (WP8.3): a report is charged once per attempt the ledger
// handed out and a release is taken only from the running attempt; a released task's deadline
// doubles, three times at most, and a node's loss is not a release; the machine's presign budget
// answers with nothing instead of closing an honest connection.
import { describe, expect, test } from "bun:test";
import { CLOSE, PROTOCOL_VERSION, RELEASED } from "@tabframe/protocol";
import { H, harness, renderSpec } from "./harness.ts";
import { COMPUTE_MS_REPORT_CAP, RELEASES_PER_TASK_CAP } from "./policy.ts";

/** The assign messages in a batch of effects, deadlines included. */
function assignMsgs(effects: ReturnType<ReturnType<typeof harness>["tick"]>) {
  return effects.flatMap((e) =>
    e.kind === "send" && e.msg.t === "assign"
      ? [
          {
            connId: e.connId,
            taskId: e.msg.taskId,
            attempt: e.msg.attempt,
            deadlineMs: e.msg.deadlineMs,
          },
        ]
      : [],
  );
}

/** One node, a person's launch, the plan done: run tasks of stage 0 are assigned to c1. */
function withRunTasks(tasks = 2) {
  const h = harness();
  h.addProgram();
  h.subscribe("o1");
  h.hello("c1", "h1");
  const launched = h.launch({ preset: 1 }, true);
  const [plan] = h.assigns(launched);
  if (!plan) throw new Error("no plan assign");
  const spec = h.planSpec(
    h.result(plan.connId, plan.taskId, plan.attempt, H("a")),
    renderSpec(tasks),
  );
  const runs = assignMsgs(spec);
  if (runs.length === 0) throw new Error("no run assigns");
  const exec = [...h.ledger.executions.values()].find((e) => e.status === "running");
  if (!exec) throw new Error("no running execution");
  return { h, runs, exec };
}

describe("charges land once per attempt (WP8.3)", () => {
  test("a replayed report neither spends the budget again nor feeds the deadline model twice", () => {
    const { h, runs, exec } = withRunTasks();
    const a = runs[0] as (typeof runs)[number];
    const before = exec.computeMsUsed; // the plan task's own charge
    h.result(a.connId, a.taskId, a.attempt, H("b"), { computeMs: 500 });
    expect(exec.computeMsUsed).toBe(before + 500);
    expect(exec.computeSamples).toEqual([500]);
    const node = h.ledger.nodes.get("n1");
    const done = node?.tasksDone;
    // The same report again: a duplicate settles nothing and charges nothing.
    h.result(a.connId, a.taskId, a.attempt, H("b"), { computeMs: 500 });
    expect(exec.computeMsUsed).toBe(before + 500);
    expect(exec.computeSamples).toEqual([500]);
    expect(node?.tasksDone).toBe(done);
  });

  test("a release for an attempt that is not running is ignored, not charged", () => {
    const { h, runs, exec } = withRunTasks();
    const a = runs[0] as (typeof runs)[number];
    h.result(a.connId, a.taskId, a.attempt, H("b"), { computeMs: 100 });
    const used = exec.computeMsUsed;
    const task = h.ledger.tasks.get(a.taskId);
    // Six replayed releases of the settled attempt used to fail the task as "released 6 times".
    for (let i = 0; i < RELEASES_PER_TASK_CAP; i++)
      h.resultError(a.connId, a.taskId, a.attempt, RELEASED);
    expect(task?.status).toBe("done");
    expect(exec.computeMsUsed).toBe(used);
    expect(task?.attempts.filter((x) => x.outcome === "released")).toHaveLength(0);
  });
});

describe("deadlines under releases (WP8.3)", () => {
  test("a released task comes back with a doubled deadline, three doublings at most", () => {
    const { h, runs } = withRunTasks(1);
    const first = runs[0] as (typeof runs)[number];
    let assign = first;
    const seen = [first.deadlineMs];
    for (let i = 0; i < 5; i++) {
      const effects = h.resultError(assign.connId, assign.taskId, assign.attempt, RELEASED);
      const next = [...assignMsgs(effects), ...assignMsgs(h.tick())].find(
        (x) => x.taskId === first.taskId,
      );
      if (!next) throw new Error(`no re-assignment after release ${i + 1}`);
      seen.push(next.deadlineMs);
      assign = next;
    }
    const base = first.deadlineMs;
    expect(seen).toEqual([base, base * 2, base * 4, base * 8, base * 8, base * 8]);
    expect(seen.every((d) => d <= COMPUTE_MS_REPORT_CAP)).toBe(true);
  });

  test("a node that leaves loses its attempts; a loss is not a release and does not count toward the cap", () => {
    const { h, runs } = withRunTasks(1);
    const a = runs[0] as (typeof runs)[number];
    h.disconnect(a.connId);
    const task = h.ledger.tasks.get(a.taskId);
    expect(task?.attempts.map((x) => x.outcome)).toEqual(["lost"]);
    expect(task?.status).toBe("pending");
    // A new node gets it at the base deadline: no release happened.
    const effects = h.hello("c2", "h2");
    const again = [...assignMsgs(effects), ...assignMsgs(h.tick())].find(
      (x) => x.taskId === a.taskId,
    );
    expect(again?.deadlineMs).toBe(a.deadlineMs);
  });
});

describe("the machine's presign budget (WP8.3)", () => {
  test("a node over the machine budget gets an empty presign and stays connected; an observer gets an error", () => {
    const h = harness();
    h.subscribe("o1");
    h.hello("c1", "h1");
    h.ledger.session.presignItems.tokens = 0;
    h.ledger.session.presignItems.refilledAt = h.now;
    const node = h.send("c1", { t: "presign", items: [{ hash: H("f"), size: 10 }] });
    expect(node).toEqual([
      {
        kind: "send",
        connId: "c1",
        msg: { t: "presigned", v: PROTOCOL_VERSION, gen: h.gen, urls: [] },
      },
    ]);
    expect(node.some((e) => e.kind === "close")).toBe(false);
    const obs = h.send("o1", { t: "presign", items: [{ hash: H("f"), size: 10 }] });
    expect(obs.some((e) => e.kind === "send" && e.msg.t === "error")).toBe(true);
    expect(obs.some((e) => e.kind === "close")).toBe(false);
    // A connection over its own budget is still closed.
    h.ledger.session.presignItems.tokens = 10_000;
    const conn = h.ledger.conns.get("c1");
    if (conn) conn.presignBytes.tokens = 0;
    const closed = h.send("c1", { t: "presign", items: [{ hash: H("f"), size: 10 }] });
    expect(closed.some((e) => e.kind === "close" && e.code === CLOSE.rateLimited)).toBe(true);
  });
});
