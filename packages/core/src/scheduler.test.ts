import { describe, expect, test } from "bun:test";
import { byteLength, canonicalStringify, encode, LIMITS, type StageSpec } from "@tabframe/protocol";
import { executionTasks } from "./executions.ts";
import { doneSpec, eventsOf, H, harness, renderSpec } from "./harness.ts";
import { taskView } from "./ledger.ts";

/** Bring up a program, an observer, n nodes, and an execution with a rendered stage of `tasks` tasks. */
function machine(nodes: number, tasks: number, opts: { redundancy?: boolean } = {}) {
  const h = harness();
  h.addProgram();
  h.subscribe("o1");
  if (opts.redundancy) h.send("o1", { t: "setRedundancy", on: true });
  for (let i = 1; i <= nodes; i++) h.hello(`c${i}`, `h${i}`);
  const launched = h.launch();
  // The first act is a plan task (two attempts with redundancy on, which must agree).
  const plan = h.assigns(launched);
  expect(plan.length).toBe(opts.redundancy ? 2 : 1);
  expect(plan.every((p) => p.kind === "plan")).toBe(true);
  let planned: ReturnType<typeof h.result> = [];
  for (const p of plan) planned = [...planned, ...h.result(p.connId, p.taskId, p.attempt, H("a"))];
  const spec = h.planSpec(planned, renderSpec(tasks));
  return { h, spec };
}

describe("fill", () => {
  test("a plan task starts the execution; the spec materializes tasks and fills every free slot", () => {
    const { h, spec } = machine(2, 6);
    const a = h.assigns(spec);
    expect(a.length).toBe(2 * LIMITS.maxInFlight);
    expect(new Set(a.map((x) => x.taskId)).size).toBe(4);
    expect(eventsOf(spec, "o1")).toContain("stageStarted");
    expect(h.ledger.executions.get("e1")?.counters).toMatchObject({ pending: 2, assigned: 4 });
    expect(h.invariants()).toEqual([]);
  });

  test("results refill the slot, complete the stage, fold, and finish the execution", () => {
    const { h, spec } = machine(1, 3);
    let assigns = h.assigns(spec);
    const done: string[] = [];
    for (let i = 0; i < 10 && assigns.length > 0; i++) {
      const a = assigns[0] as NonNullable<(typeof assigns)[0]>;
      const effects = h.result(a.connId, a.taskId, a.attempt, H(String(i % 10)));
      done.push(a.taskId);
      expect(eventsOf(effects, "o1")).toContain("taskDone");
      const rest = assigns.slice(1);
      assigns = [...rest, ...h.assigns(effects)];
      const fold = effects.find((e) => e.kind === "putBlob");
      if (fold) {
        const stored = h.manifestStored(effects);
        expect(eventsOf(stored, "o1")).toContain("stageDone");
        const plan2 = h.assigns(stored);
        expect(plan2[0]?.kind).toBe("plan");
        const p = plan2[0] as NonNullable<(typeof plan2)[0]>;
        const finished = h.planSpec(h.result(p.connId, p.taskId, p.attempt, H("e")), doneSpec());
        expect(eventsOf(finished, "o1")).toContain("executionDone");
        expect(h.ledger.executions.get("e1")?.status).toBe("done");
        expect(h.ledger.executions.get("e1")?.files["/out/0/0"]).toBeDefined();
        expect(h.ledger.running).toBeNull();
        break;
      }
    }
    expect(new Set(done).size).toBe(3);
    expect(h.invariants()).toEqual([]);
  });

  test("released work outranks fresh work: a dead node's tiles go to the front", () => {
    const { h, spec } = machine(2, 8);
    const a = h.assigns(spec);
    const onC1 = a.filter((x) => x.connId === "c1").map((x) => x.taskId);
    expect(onC1.length).toBe(2);
    const left = h.disconnect("c1");
    expect(eventsOf(left, "o1").filter((t) => t === "taskReassigned").length).toBe(2);
    for (const id of onC1)
      expect(h.ledger.tasks.get(id)).toMatchObject({ status: "pending", released: true });
    const refill = h.assigns(h.hello("c3", "h3"));
    const c3 = refill.filter((x) => x.connId === "c3").map((x) => x.taskId);
    expect(c3.sort()).toEqual([...onC1].sort());
    expect(h.ledger.executions.get("e1")?.counters.reassigned).toBe(2);
    expect(h.invariants()).toEqual([]);
  });

  test("silence releases the same way as a close", () => {
    const { h, spec } = machine(1, 4);
    const a = h.assigns(spec);
    h.advance(LIMITS.goneAfterMs + 1);
    const swept = h.tick();
    expect(swept.some((e) => e.kind === "close")).toBe(true);
    for (const x of a) expect(h.ledger.tasks.get(x.taskId)?.status).toBe("pending");
    expect(h.ledger.nodes.size).toBe(0);
    expect(h.invariants()).toEqual([]);
  });
});

describe("deadlines and speculation", () => {
  test("an overdue attempt gets a twin only when nothing else is pending; first result wins, the twin is cancelled", () => {
    const { h, spec } = machine(2, 2);
    const a = h.assigns(spec);
    expect(a.length).toBe(2);
    // Complete everything on c2 quickly so c2 is free and only c1's task remains, overdue.
    const onC2 = a.find((x) => x.connId === "c2") as NonNullable<(typeof a)[0]>;
    const onC1 = a.find((x) => x.connId === "c1") as NonNullable<(typeof a)[0]>;
    h.result(onC2.connId, onC2.taskId, onC2.attempt, H("1"));
    expect(h.assigns(h.tick()).length).toBe(0); // not overdue yet
    h.advance(h.ledger.config.deadlineFloorMs + 1);
    const spec2 = h.assigns(h.tick());
    expect(spec2.length).toBe(1);
    expect(spec2[0]?.taskId).toBe(onC1.taskId);
    expect(spec2[0]?.connId).toBe("c2");
    expect(h.ledger.executions.get("e1")?.counters.speculated).toBe(1);
    // The twin finishes first; the original holder gets a cancel.
    const twin = spec2[0] as NonNullable<(typeof spec2)[0]>;
    const effects = h.result(twin.connId, twin.taskId, twin.attempt, H("2"));
    expect(
      effects.some((e) => e.kind === "send" && e.connId === "c1" && e.msg.t === "cancel"),
    ).toBe(true);
    expect(h.ledger.tasks.get(onC1.taskId)?.status).toBe("done");
    // The original's late result verifies against the accepted one.
    const late = h.result(onC1.connId, onC1.taskId, onC1.attempt, H("2"));
    expect(eventsOf(late, "o1")).toContain("taskVerified");
    expect(h.ledger.executions.get("e1")?.counters.verified).toBe(1);
    expect(h.invariants()).toEqual([]);
  });

  test("deadline is the floor until samples exist, then three times the median", () => {
    const { h, spec } = machine(1, 6);
    const exec = h.ledger.executions.get("e1");
    if (!exec) throw new Error("no execution");
    expect(h.assigns(spec)[0]).toBeDefined();
    let a = h.assigns(spec);
    for (const ms of [100, 300, 200]) {
      const x = a[0] as NonNullable<(typeof a)[0]>;
      const effects = h.result(x.connId, x.taskId, x.attempt, H("3"), { computeMs: ms });
      a = [...a.slice(1), ...h.assigns(effects)];
    }
    expect(exec.computeSamples).toEqual([100, 300, 200]);
    const last = a[0] as NonNullable<(typeof a)[0]>;
    const task = h.ledger.tasks.get(last.taskId);
    const attempt = task?.attempts.find((at) => at.outcome === "running");
    expect(attempt && attempt.deadlineAt - attempt.assignedAt).toBe(
      h.ledger.config.deadlineFloorMs,
    );
    exec.computeSamples = [1000, 1200, 1100];
    h.advance(1);
    const fresh = h.assigns(h.hello("c9", "h9"));
    const t2 = h.ledger.tasks.get(fresh[0]?.taskId ?? "");
    const at2 = t2?.attempts.find((at) => at.outcome === "running");
    expect(at2 && at2.deadlineAt - at2.assignedAt).toBe(3300);
  });
});

describe("verification", () => {
  test("a disagreeing duplicate contests the tile: retracted, recomputed, and voted on after two rounds", () => {
    // Two tasks, so the stage is still open (unsealed) when the late duplicate arrives.
    const { h, spec } = machine(2, 2);
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
    const { h, spec } = machine(2, 2);
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
    const { h, spec } = machine(2, 1);
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
    const { h, spec } = machine(2, 1, { redundancy: true });
    const a = h.assigns(spec);
    expect(a.length).toBe(2);
    expect(new Set(a.map((x) => x.connId)).size).toBe(2);
    const [x, y] = a as [NonNullable<(typeof a)[0]>, NonNullable<(typeof a)[0]>];
    const first = h.result(x.connId, x.taskId, x.attempt, H("7"));
    expect(eventsOf(first, "o1")).not.toContain("taskDone");
    expect(h.ledger.tasks.get(x.taskId)?.status).toBe("assigned");
    const second = h.result(y.connId, y.taskId, y.attempt, H("7"));
    expect(eventsOf(second, "o1")).toContain("taskDone");
    expect(h.invariants()).toEqual([]);
  });

  test("under redundancy the second attempt never goes to the node that already answered", () => {
    const { h, spec } = machine(2, 1, { redundancy: true });
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
    const { h, spec } = machine(2, 1, { redundancy: true });
    const [x, y] = h.assigns(spec) as [
      NonNullable<ReturnType<typeof h.assigns>[0]>,
      NonNullable<ReturnType<typeof h.assigns>[0]>,
    ];
    h.result(x.connId, x.taskId, x.attempt, H("7"));
    const repeat = h.result(x.connId, x.taskId, 9, H("7"));
    expect(eventsOf(repeat, "o1")).not.toContain("taskDone");
    expect(h.ledger.tasks.get(x.taskId)?.results.length).toBe(1);
    expect(h.ledger.executions.get("e1")?.counters.verified).toBe(0);
    const done = h.result(y.connId, y.taskId, y.attempt, H("7"));
    expect(eventsOf(done, "o1")).toContain("taskDone");
    expect(h.invariants()).toEqual([]);
  });

  test("the vote counts nodes, not reports: a persistent liar is outvoted by two honest nodes", () => {
    // Three nodes, one task each. c1 lies on its task; c2 disagrees late; c3 recomputes.
    const { h, spec } = machine(3, 3);
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

  test("a stale result for a cancelled attempt is evidence but closes no newer attempt", () => {
    // c1 holds t1@1 and t3; c2 holds t2. A late result from c2 settles t1 and cancels c1's attempt.
    const { h, spec } = machine(3, 3);
    const [a] = h.assigns(spec);
    if (!a) throw new Error("no assign");
    expect(a.connId).toBe("c1");
    h.result("c2", a.taskId, 9, H("2"));
    expect(h.ledger.tasks.get(a.taskId)?.status).toBe("done");
    // c3 disagrees late: contested, and c1 (a free slot) gets t1 again as attempt 2.
    const [again] = h.assigns(h.result("c3", a.taskId, 9, H("3")));
    if (!again) throw new Error("no reassignment");
    expect(again).toMatchObject({ connId: "c1", taskId: a.taskId, attempt: 2 });
    // Now c1's result for the cancelled attempt 1 arrives. It settles round two (one result is
    // enough with the toggle off), which cancels attempt 2 and tells c1 so; attempt 2 is never
    // marked as reported, and c1's in-flight list agrees with what c1 holds.
    const stale = h.result("c1", a.taskId, 1, H("1"));
    const task = h.ledger.tasks.get(a.taskId);
    expect(task?.status).toBe("done");
    expect(task?.accepted?.output).toBe(H("1"));
    expect(task?.attempts.find((x) => x.attempt === 2)?.outcome).toBe("cancelled");
    expect(stale.some((e) => e.kind === "send" && e.connId === "c1" && e.msg.t === "cancel")).toBe(
      true,
    );
    expect(h.ledger.nodes.get("n1")?.inFlight).not.toContain(a.taskId);
    expect(h.invariants()).toEqual([]);
  });

  test("a contested task is recomputed by a node that has not reported, when one is free", () => {
    // With a third node idle, the recompute skips both nodes that already weighed in.
    const three = machine(3, 3);
    const [x] = three.h.assigns(three.spec);
    if (!x) throw new Error("no assign");
    three.h.result(x.connId, x.taskId, x.attempt, H("a"));
    const [fresh] = three.h.assigns(three.h.result("c2", x.taskId, 9, H("b")));
    expect(fresh).toMatchObject({ connId: "c3", taskId: x.taskId });
    // With nobody fresh, anyone free takes it: the cluster of two still makes progress.
    const two = machine(2, 2);
    const [y] = two.h.assigns(two.spec);
    if (!y) throw new Error("no assign");
    two.h.result(y.connId, y.taskId, y.attempt, H("a"));
    const [anyone] = two.h.assigns(two.h.result("c2", y.taskId, 9, H("b")));
    expect(anyone).toMatchObject({ connId: "c1", taskId: y.taskId });
    expect(three.h.invariants()).toEqual([]);
    expect(two.h.invariants()).toEqual([]);
  });

  test("a tie after two rounds is not settled by report order: another round decides", () => {
    // Two nodes disagree twice, one vote each: nothing is painted; a third round starts instead.
    const { h, spec } = machine(2, 2);
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
    const { h, spec } = machine(1, 2);
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
    const { h, spec } = machine(1, 2);
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

describe("queue and controls", () => {
  test("human launches go ahead of automatic continuations; the default loop runs while someone watches", () => {
    const h = harness({ defaultLoop: { bundle: "b".repeat(64), params: { preset: 0 } } });
    h.subscribe("o1");
    h.addProgram();
    expect(h.ledger.running).toBe("e1");
    expect(h.ledger.executions.get("e1")?.human).toBe(false);
    h.launch({ preset: 5 }, true);
    h.event({
      kind: "launch",
      bundle: "b".repeat(64),
      params: { preset: 1 },
      human: false,
      inherit: null,
    });
    h.launch({ preset: 6 }, true);
    expect(h.ledger.queue).toEqual(["e2", "e4", "e3"]);
    expect(h.invariants()).toEqual([]);
  });

  test("kill half commands a random half and announces the victims; resume undoes throttle", () => {
    const h = harness();
    h.subscribe("o1");
    for (let i = 1; i <= 4; i++) h.hello(`c${i}`, `h${i}`);
    const killed = h.send("o1", { t: "killHalf" });
    const commands = killed.filter((e) => e.kind === "send" && e.msg.t === "command");
    expect(commands.length).toBe(2);
    const applied = killed.find(
      (e) => e.kind === "send" && e.connId === "o1" && e.msg.t === "controlApplied",
    );
    expect(
      applied?.kind === "send" && applied.msg.t === "controlApplied" && applied.msg.nodeIds.length,
    ).toBe(2);
    h.send("o1", { t: "throttleHalf" });
    const resumed = h.send("o1", { t: "resumeAll" });
    expect(resumed.filter((e) => e.kind === "send" && e.msg.t === "command").length).toBe(2);
    expect(h.invariants()).toEqual([]);
  });

  test("a frozen node stays frozen: throttle does not revive it, and it is never filled", () => {
    // Six tasks, two nodes: both fill up, two stay pending. Freeze one node's record the way
    // freezeHalf does, then throttle everyone — the frozen record must survive, because `fill`
    // skips frozen nodes and a frozen worker computes nothing until the silence window ends it.
    const { h, spec } = machine(2, 6);
    expect(h.assigns(spec).length).toBe(4);
    const frozen = h.ledger.nodes.get("n1");
    if (!frozen) throw new Error("no node");
    frozen.commanded = "freeze";
    const throttled = h.send("o1", { t: "throttleHalf" });
    expect(frozen.commanded).toBe("freeze");
    // Free both of its slots, as a cancel would, then let every fill path run.
    for (const t of h.ledger.tasks.values()) {
      for (const a of t.attempts) {
        if (a.nodeId === "n1" && a.outcome === "running") a.outcome = "cancelled";
      }
    }
    frozen.inFlight = [];
    for (const e of [...throttled, ...h.tick(), ...h.heartbeat("c2")]) {
      if (e.kind === "send" && e.msg.t === "assign") expect(e.connId).not.toBe(frozen.connId);
    }
    // resumeAll wakes throttled workers only; the frozen one is left for the sweep.
    const woken = h
      .send("o1", { t: "resumeAll" })
      .filter((e) => e.kind === "send" && e.msg.t === "command")
      .map((e) => (e.kind === "send" ? e.connId : ""));
    expect(woken).not.toContain(frozen.connId);
    expect(frozen.commanded).toBe("freeze");
  });

  test("skip cancels the running execution and starts the next; restart relaunches the same program first", () => {
    const { h } = machine(1, 2);
    h.launch({ preset: 9 }, true);
    expect(h.ledger.queue).toEqual(["e2"]);
    const skipped = h.send("o1", { t: "skip" });
    expect(eventsOf(skipped, "o1")).toContain("executionFailed");
    expect(h.ledger.running).toBe("e2");
    const restarted = h.send("o1", { t: "restart" });
    expect(eventsOf(restarted, "o1")).toContain("controlApplied");
    expect(h.ledger.running).toBe("e3");
    expect(h.ledger.executions.get("e3")?.params).toEqual({ preset: 9 });
    expect(h.invariants()).toEqual([]);
  });

  test("controls before subscribe, unknown programs, and follow-ups", () => {
    const h = harness();
    h.connect("o1", "observer");
    expect(h.send("o1", { t: "killHalf" })[0]).toMatchObject({ kind: "close" });
    h.subscribe("o2");
    // A bundle the ledger does not know is an upload: the process is asked to resolve it (WP2.3).
    const unknown = h.send("o2", { t: "launch", bundle: "c".repeat(64), params: {} });
    expect(unknown[0]).toMatchObject({ kind: "resolveBundle", bundle: "c".repeat(64) });
    const rejected = h.event({
      kind: "bundleRejected",
      bundle: "c".repeat(64),
      connId: "o2",
      reason: "forbidden imports: env.now",
    });
    expect(
      rejected[0]?.kind === "send" && rejected[0].msg.t === "error" && rejected[0].msg.code,
    ).toBe("launch-refused");
    const none = h.send("o2", { t: "runFollowUp", executionId: "e99" });
    expect(none[0]?.kind === "send" && none[0].msg.t === "error").toBe(true);
  });

  test("snapshot pages carry the cluster on page 0 and the execution's tasks", () => {
    const { h } = machine(1, 300);
    const pages = h.subscribe("o2").filter((e) => e.kind === "send" && e.msg.t === "snapshot");
    expect(pages.length).toBe(2);
    const first = pages[0];
    expect(first?.kind === "send" && first.msg.t === "snapshot" && first.msg.nodes?.length).toBe(1);
    expect(
      first?.kind === "send" && first.msg.t === "snapshot" && first.msg.execution?.taskCount,
    ).toBe(300);
    const second = pages[1];
    expect(
      second?.kind === "send" && second.msg.t === "snapshot" && second.msg.nodes,
    ).toBeUndefined();
  });

  test("snapshot pages stay under the message cap for a full frame of done tiles", () => {
    // A done tile's row is about 250 bytes: 256 of them alone exceed the 64 KiB message cap.
    const h = harness();
    h.addProgram();
    h.subscribe("o1");
    for (let i = 1; i <= 24; i++) h.hello(`c${i}`, `h${i}`);
    h.ledger.meta.taskCounter = 9000;
    const [plan] = h.assigns(h.launch());
    if (!plan) throw new Error("no plan task");
    const frame: StageSpec = {
      kind: "stage",
      name: "render",
      canvas: { w: 2048, h: 1280 },
      tasks: Array.from({ length: 640 }, (_, i) => ({
        input: new Uint8Array([i & 255]),
        place: { x: (i % 32) * 64, y: Math.floor(i / 32) * 64, w: 64, h: 64 },
      })),
    };
    let assigns = h.assigns(
      h.planSpec(h.result(plan.connId, plan.taskId, plan.attempt, H("a")), frame),
    );
    while (assigns.length > 0) {
      let next: typeof assigns = [];
      for (const a of assigns)
        next = [
          ...next,
          ...h.assigns(h.result(a.connId, a.taskId, a.attempt, H("7"), { outputSize: 16384 })),
        ];
      assigns = next;
    }
    expect(h.ledger.executions.get("e1")?.counters.done).toBe(641);
    const rows = executionTasks(h.ledger, "e1").map(taskView);
    expect(byteLength(canonicalStringify(rows.slice(1, 257)))).toBeGreaterThan(
      LIMITS.maxMessageBytes - 2048,
    );
    const pages = h.subscribe("o2").filter((e) => e.kind === "send" && e.msg.t === "snapshot");
    expect(pages.length).toBeGreaterThanOrEqual(3);
    let seen = 0;
    for (const p of pages) {
      if (p.kind !== "send" || p.msg.t !== "snapshot") throw new Error("unreachable");
      expect(() => encode(p.msg)).not.toThrow();
      expect(p.msg.pages).toBe(pages.length);
      expect(p.msg.tasks.length).toBeLessThanOrEqual(LIMITS.snapshotPageTasks);
      seen += p.msg.tasks.length;
    }
    // Every task of the execution appears exactly once across the pages, the plan task included.
    expect(seen).toBe(641);
  });
});
