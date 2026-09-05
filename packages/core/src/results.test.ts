import { describe, expect, test } from "bun:test";
import { RELEASED } from "@tabframe/protocol";
import { doneSpec, eventsOf, H, harness, renderSpec } from "./harness.ts";
import { RELEASES_PER_TASK_CAP } from "./policy.ts";
import { runningAttempts } from "./tasks.ts";

/** Settlement (design §6.5, D7): agreement, verification, contest, the vote, and what a report may charge. */

describe("verification", () => {
  test("a disagreeing duplicate contests the tile: retracted, recomputed, and voted on after two rounds", () => {
    // Two tasks, so the stage is still open (unsealed) when the late duplicate arrives.
    const h = harness();
    const spec = h.stage(2, 2);
    const [a] = h.assigns(spec);
    if (!a) throw new Error("no assign");
    h.result(a.connId, a.taskId, a.attempt, H("1"));
    expect(h.ledger.tasks.get(a.taskId)?.status).toBe("done");
    // A late, different result from the other node (which was never assigned): the task is contested.
    const other = a.connId === "c1" ? "c2" : "c1";
    const contested = h.result(other, a.taskId, 9, H("2"));
    expect(eventsOf(contested, "o1")).toContain("taskMismatch");
    const task = h.ledger.tasks.get(a.taskId);
    expect(task?.contestedRounds).toBe(1);
    expect(task?.accepted).toBeNull();
    // Round two: reassigned at once (a free node exists), two nodes disagree again → round three → vote.
    const again = h.assigns(contested);
    expect(again.length).toBe(1);
    expect(task?.status).toBe("assigned");
    const r1 = again[0] as NonNullable<(typeof again)[0]>;
    h.result(r1.connId, r1.taskId, r1.attempt, H("2"));
    expect(h.ledger.tasks.get(a.taskId)?.status).toBe("done");
    const r2 = h.result(r1.connId === "c1" ? "c2" : "c1", a.taskId, 9, H("3"));
    expect(eventsOf(r2, "o1")).toContain("taskMismatch");
    // After the second contested round the majority across all results wins: H("2") appeared twice.
    expect(h.ledger.tasks.get(a.taskId)).toMatchObject({ status: "done", resolvedByVote: true });
    expect(h.ledger.tasks.get(a.taskId)?.accepted?.output).toBe(H("2"));
    expect(h.ledger.executions.get("e1")?.counters.mismatched).toBe(2);
    expect(h.invariants()).toEqual([]);
  });

  test("the vote's outcome reaches nodes and observers when a late duplicate triggers it", () => {
    const h = harness();
    const spec = h.stage(2, 2);
    const [a] = h.assigns(spec);
    if (!a) throw new Error("no assign");
    const other = a.connId === "c1" ? "c2" : "c1";
    h.result(a.connId, a.taskId, a.attempt, H("1"));
    const contested = h.result(other, a.taskId, 9, H("2"));
    const [again] = h.assigns(contested);
    if (!again) throw new Error("no reassignment");
    h.result(again.connId, again.taskId, again.attempt, H("2"));
    const seqBefore = h.ledger.meta.seq;
    const voted = h.result(again.connId === "c1" ? "c2" : "c1", a.taskId, 9, H("3"));
    // The mismatch and the vote's taskDone are both announced, with consecutive sequence numbers.
    const events = eventsOf(voted, "o1");
    expect(events).toEqual(["taskMismatch", "taskDone"]);
    const seqs = voted
      .filter((e) => e.kind === "send" && e.connId === "o1")
      .map((e) => (e.kind === "send" && "seq" in e.msg ? e.msg.seq : -1));
    expect(seqs).toEqual([seqBefore + 1, seqBefore + 2]);
    expect(h.ledger.tasks.get(a.taskId)).toMatchObject({ status: "done", resolvedByVote: true });
    expect(h.invariants()).toEqual([]);
  });

  test("a mismatch after the fold is announced but withdraws nothing", () => {
    const h = harness();
    const spec = h.stage(2, 1);
    const [a] = h.assigns(spec);
    if (!a) throw new Error("no assign");
    const folded = h.result(a.connId, a.taskId, a.attempt, H("1"));
    expect(folded.some((e) => e.kind === "putBlob")).toBe(true);
    const other = a.connId === "c1" ? "c2" : "c1";
    const late = h.result(other, a.taskId, 9, H("2"));
    expect(eventsOf(late, "o1")).toEqual(["taskMismatch"]);
    expect(h.assigns(late)).toEqual([]);
    const task = h.ledger.tasks.get(a.taskId);
    expect(task).toMatchObject({ status: "done", contestedRounds: 0 });
    expect(task?.accepted?.output).toBe(H("1"));
    expect(h.ledger.executions.get("e1")?.counters.mismatched).toBe(1);
    // The stage advances on the manifest that was folded; the execution finishes cleanly.
    const stored = h.manifestStored(folded);
    const [plan] = h.assigns(stored);
    if (!plan) throw new Error("no plan task");
    expect(plan.kind).toBe("plan");
    const done = h.result(plan.connId, plan.taskId, plan.attempt, H("9"));
    const finished = h.planSpec(done, doneSpec());
    expect(eventsOf(finished, "o1")).toContain("executionDone");
    expect(h.ledger.executions.get("e1")?.status).toBe("done");
    for (const n of h.ledger.nodes.values()) expect(n.inFlight).toEqual([]);
    expect(h.invariants()).toEqual([]);
  });

  test("with redundancy on, a task needs two agreeing results before it is done", () => {
    const h = harness();
    const spec = h.stage(2, 1, { redundancy: true });
    const a = h.assigns(spec);
    expect(a.length).toBe(2);
    expect(new Set(a.map((x) => x.connId)).size).toBe(2);
    const [x, y] = a as [NonNullable<(typeof a)[0]>, NonNullable<(typeof a)[0]>];
    const first = h.result(x.connId, x.taskId, x.attempt, H("7"));
    expect(eventsOf(first, "o1")).not.toContain("taskDone");
    expect(h.ledger.tasks.get(x.taskId)?.status).toBe("assigned");
    const second = h.result(y.connId, y.taskId, y.attempt, H("7"));
    expect(eventsOf(second, "o1")).toContain("taskDone");
    // The pair that settles a task together is a verification: the toggle's counter moves —
    // twice here, since the plan task was settled by two agreeing nodes as well.
    expect(eventsOf(second, "o1")).toContain("taskVerified");
    const exec = [...h.ledger.executions.values()][0];
    expect(exec?.counters.verified).toBe(2);
    expect(h.invariants()).toEqual([]);
  });

  test("under redundancy the second attempt never goes to the node that already answered", () => {
    const h = harness();
    const spec = h.stage(2, 1, { redundancy: true });
    const [x, y] = h.assigns(spec) as [
      NonNullable<ReturnType<typeof h.assigns>[0]>,
      NonNullable<ReturnType<typeof h.assigns>[0]>,
    ];
    // The twin's node dies before reporting; the first node reports and has a free slot.
    h.disconnect(y.connId);
    const effects = h.result(x.connId, x.taskId, x.attempt, H("7"));
    expect(h.assigns(effects)).toEqual([]);
    expect(h.assigns(h.tick())).toEqual([]);
    const task = h.ledger.tasks.get(x.taskId);
    expect(task?.status).toBe("assigned");
    expect(task?.results.length).toBe(1);
    // A third node brings the independent computation the toggle promises.
    const [z] = h.assigns(h.hello("c3", "h3"));
    if (!z) throw new Error("no assign for the newcomer");
    expect(z.taskId).toBe(x.taskId);
    expect(z.connId).toBe("c3");
    const done = h.result("c3", z.taskId, z.attempt, H("7"));
    expect(eventsOf(done, "o1")).toContain("taskDone");
    expect(h.invariants()).toEqual([]);
  });

  test("a node cannot agree with itself: a repeat report in the same round adds nothing", () => {
    const h = harness();
    const spec = h.stage(2, 1, { redundancy: true });
    const [x, y] = h.assigns(spec) as [
      NonNullable<ReturnType<typeof h.assigns>[0]>,
      NonNullable<ReturnType<typeof h.assigns>[0]>,
    ];
    h.result(x.connId, x.taskId, x.attempt, H("7"));
    const repeat = h.result(x.connId, x.taskId, 9, H("7"));
    expect(eventsOf(repeat, "o1")).not.toContain("taskDone");
    expect(h.ledger.tasks.get(x.taskId)?.results.length).toBe(1);
    // Only the plan task's agreement has been counted; the repeat verified nothing.
    expect(h.ledger.executions.get("e1")?.counters.verified).toBe(1);
    const done = h.result(y.connId, y.taskId, y.attempt, H("7"));
    expect(eventsOf(done, "o1")).toContain("taskDone");
    expect(h.ledger.executions.get("e1")?.counters.verified).toBe(2);
    expect(h.invariants()).toEqual([]);
  });

  test("the vote counts nodes, not reports: a persistent liar is outvoted by two honest nodes", () => {
    // Three nodes, one task each. c1 lies on its task; c2 disagrees late; c3 recomputes.
    const h = harness();
    const spec = h.stage(3, 3);
    const [a] = h.assigns(spec);
    if (!a) throw new Error("no assign");
    expect(a.connId).toBe("c1");
    h.result(a.connId, a.taskId, a.attempt, H("a"));
    const [again] = h.assigns(h.result("c2", a.taskId, 9, H("b")));
    if (!again) throw new Error("no reassignment");
    expect(again.connId).toBe("c3");
    h.result("c3", again.taskId, again.attempt, H("b"));
    expect(h.ledger.tasks.get(a.taskId)?.accepted?.output).toBe(H("b"));
    // c1 insists, late: two reports from one node are one vote, against two nodes for b.
    h.result("c1", a.taskId, 9, H("a"));
    const task = h.ledger.tasks.get(a.taskId);
    expect(task).toMatchObject({ status: "done", resolvedByVote: true, contestedRounds: 2 });
    expect(task?.accepted?.output).toBe(H("b"));
    expect(h.invariants()).toEqual([]);
  });

  test("a late result for a released attempt settles the task and closes no newer attempt", () => {
    // c1 holds t1@1 and gives it up at its deadline; c2 takes it as attempt 2. Then c1's result for
    // attempt 1 arrives late: the attempt is known (released), so it counts (an unknown attempt
    // could not settle an open task), it settles the round, and it cancels attempt 2 on c2 —
    // attempt 2 is never marked as reported, and c2's in-flight list agrees with what c2 holds.
    const h = harness();
    const spec = h.stage(2, 3);
    const [a] = h.assigns(spec);
    if (!a) throw new Error("no assign");
    expect(a.connId).toBe("c1");
    const released = h.resultError(a.connId, a.taskId, a.attempt, RELEASED);
    const again = h.assigns(released).find((x) => x.taskId === a.taskId);
    if (!again) throw new Error("no reassignment");
    expect(again).toMatchObject({ connId: "c2", taskId: a.taskId, attempt: 2 });
    const stale = h.result("c1", a.taskId, 1, H("1"));
    const task = h.ledger.tasks.get(a.taskId);
    expect(task?.status).toBe("done");
    expect(task?.accepted?.output).toBe(H("1"));
    expect(task?.attempts.find((x) => x.attempt === 2)?.outcome).toBe("cancelled");
    expect(stale.some((e) => e.kind === "send" && e.connId === "c2" && e.msg.t === "cancel")).toBe(
      true,
    );
    expect(h.ledger.nodes.get("n2")?.inFlight).not.toContain(a.taskId);
    expect(h.invariants()).toEqual([]);
  });

  test("a result from a node that was never given an open task does not settle it", () => {
    const h = harness();
    const spec = h.stage(2, 2);
    const [a] = h.assigns(spec);
    if (!a) throw new Error("no assign");
    const other = a.connId === "c1" ? "c2" : "c1";
    h.result(other, a.taskId, 9, H("9"));
    expect(h.ledger.tasks.get(a.taskId)?.status).toBe("assigned");
    expect(h.ledger.tasks.get(a.taskId)?.accepted).toBeNull();
    // The node that holds it settles it; a late duplicate from the other may still contest it (D7).
    h.result(a.connId, a.taskId, a.attempt, H("1"));
    expect(h.ledger.tasks.get(a.taskId)?.status).toBe("done");
    const contested = h.result(other, a.taskId, 9, H("2"));
    expect(eventsOf(contested, "o1")).toContain("taskMismatch");
  });

  test("a contested task is recomputed by a node that has not reported, when one is free", () => {
    // With a third node idle, the recompute skips both nodes that already weighed in.
    const three = harness();
    const threeSpec = three.stage(3, 3);
    const [x] = three.assigns(threeSpec);
    if (!x) throw new Error("no assign");
    three.result(x.connId, x.taskId, x.attempt, H("a"));
    const [fresh] = three.assigns(three.result("c2", x.taskId, 9, H("b")));
    expect(fresh).toMatchObject({ connId: "c3", taskId: x.taskId });
    // With nobody fresh, anyone free takes it: the cluster of two still makes progress.
    const two = harness();
    const twoSpec = two.stage(2, 2);
    const [y] = two.assigns(twoSpec);
    if (!y) throw new Error("no assign");
    two.result(y.connId, y.taskId, y.attempt, H("a"));
    const [anyone] = two.assigns(two.result("c2", y.taskId, 9, H("b")));
    expect(anyone).toMatchObject({ connId: "c1", taskId: y.taskId });
    expect(three.invariants()).toEqual([]);
    expect(two.invariants()).toEqual([]);
  });

  test("a tie after two rounds is not settled by report order: another round decides", () => {
    // Two nodes disagree twice, one vote each: nothing is painted; a third round starts instead.
    const h = harness();
    const spec = h.stage(2, 2);
    const [a] = h.assigns(spec);
    if (!a) throw new Error("no assign");
    expect(a.connId).toBe("c1");
    h.result("c1", a.taskId, a.attempt, H("a"));
    const [again] = h.assigns(h.result("c2", a.taskId, 9, H("b")));
    if (!again) throw new Error("no reassignment");
    expect(again.connId).toBe("c1");
    h.result("c1", again.taskId, again.attempt, H("a"));
    const tie = h.result("c2", a.taskId, 9, H("b"));
    const task = h.ledger.tasks.get(a.taskId);
    expect(task).toMatchObject({ contestedRounds: 2, resolvedByVote: false, status: "assigned" });
    expect(eventsOf(tie, "o1")).not.toContain("taskDone");
    const [third] = h.assigns(tie);
    expect(third?.connId).toBe("c1");
    if (!third) throw new Error("no third round");
    // A third node joins. c1 reports the same bytes; c2 objects again; now a fresh node is free
    // and takes the next round, and its word makes the majority.
    h.hello("c3", "h3");
    h.result("c1", third.taskId, third.attempt, H("a"));
    const [fresh] = h.assigns(h.result("c2", a.taskId, 9, H("b")));
    expect(fresh).toMatchObject({ connId: "c3", taskId: a.taskId });
    if (!fresh) throw new Error("no fresh node");
    h.result("c3", fresh.taskId, fresh.attempt, H("b"));
    expect(h.ledger.tasks.get(a.taskId)?.accepted?.output).toBe(H("b"));
    h.result("c1", a.taskId, 9, H("a"));
    expect(h.ledger.tasks.get(a.taskId)).toMatchObject({ status: "done", resolvedByVote: true });
    expect(h.ledger.tasks.get(a.taskId)?.accepted?.output).toBe(H("b"));
    expect(h.invariants()).toEqual([]);
  });

  test("a trap fails the task and the execution; the machine moves on", () => {
    const h = harness();
    const spec = h.stage(1, 2);
    const [a] = h.assigns(spec);
    if (!a) throw new Error("no assign");
    const effects = h.resultError(a.connId, a.taskId, a.attempt, "trap: unreachable");
    expect(eventsOf(effects, "o1")).toContain("taskFailed");
    expect(eventsOf(effects, "o1")).toContain("executionFailed");
    expect(h.ledger.executions.get("e1")).toMatchObject({ status: "failed" });
    expect(h.ledger.running).toBeNull();
    expect(h.invariants()).toEqual([]);
  });

  test("a write conflict at fold fails the execution", () => {
    const h = harness();
    const spec = h.stage(1, 2);
    let a = h.assigns(spec);
    const w = (hash: string) => [{ path: "/state.json", hash, size: 1 }];
    const x = a[0] as NonNullable<(typeof a)[0]>;
    a = [
      ...a.slice(1),
      ...h.assigns(h.result(x.connId, x.taskId, x.attempt, H("1"), { writes: w(H("a")) })),
    ];
    const y = a[0] as NonNullable<(typeof a)[0]>;
    const effects = h.result(y.connId, y.taskId, y.attempt, H("2"), { writes: w(H("b")) });
    expect(eventsOf(effects, "o1")).toContain("executionFailed");
    expect(h.ledger.executions.get("e1")?.failure).toContain("write conflict");
  });
});

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
    expect(runningAttempts(task)).toBe(1);
    expect(h.invariants()).toEqual([]);
  });
});

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

describe("charges land once per attempt", () => {
  test("a replayed report neither spends the budget again nor feeds the deadline model twice", () => {
    const h = harness();
    const runs = h.assigns(h.stage(1, 2));
    const exec = h.ledger.executions.get(h.ledger.running as string);
    if (!exec) throw new Error("no running execution");
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
    const h = harness();
    const runs = h.assigns(h.stage(1, 2));
    const exec = h.ledger.executions.get(h.ledger.running as string);
    if (!exec) throw new Error("no running execution");
    const a = runs[0] as (typeof runs)[number];
    h.result(a.connId, a.taskId, a.attempt, H("b"), { computeMs: 100 });
    const used = exec.computeMsUsed;
    const task = h.ledger.tasks.get(a.taskId);
    // Replayed releases of the settled attempt must not fail the task as "released 6 times".
    for (let i = 0; i < RELEASES_PER_TASK_CAP; i++)
      h.resultError(a.connId, a.taskId, a.attempt, RELEASED);
    expect(task?.status).toBe("done");
    expect(exec.computeMsUsed).toBe(used);
    expect(task?.attempts.filter((x) => x.outcome === "released")).toHaveLength(0);
  });
});
