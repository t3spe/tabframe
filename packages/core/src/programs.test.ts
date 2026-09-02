import { describe, expect, test } from "bun:test";
import { pruneExecutions } from "./executions.ts";
import { BUNDLE, H, harness } from "./harness.ts";

/** A late observer learns the programs from the snapshot, not only from programAdded. */
describe("programs in the snapshot", () => {
  test("page 0 lists every program with its view and default params", () => {
    const h = harness();
    h.addProgram("bars");
    const effects = h.subscribe("obs");
    const snap = effects.find((e) => e.kind === "send" && e.msg.t === "snapshot");
    if (snap?.kind !== "send" || snap.msg.t !== "snapshot") throw new Error("no snapshot");
    expect(snap.msg.programs).toEqual([
      {
        bundle: BUNDLE,
        name: "demo",
        view: "bars",
        description: null,
        defaultParams: { preset: 0 },
        addedAt: expect.any(Number),
      },
    ]);
  });
});

/** The plan task of an execution as assigned: where to send its result. */
function planAssignOf(h: ReturnType<typeof harness>, executionId: string) {
  const task = [...h.ledger.tasks.values()].find(
    (t) => t.executionId === executionId && t.kind === "plan" && t.status === "assigned",
  );
  const attempt = task?.attempts.find((a) => a.outcome === "running");
  if (!task || !attempt) throw new Error(`no running plan attempt for ${executionId}`);
  const node = h.ledger.nodes.get(attempt.nodeId);
  if (!node) throw new Error("no node");
  return { connId: node.connId, taskId: task.taskId, attempt: attempt.attempt };
}

/** A newer bundle under the same name (WP4.9): the old one leaves the list and its chain ends. */
describe("retiring a program", () => {
  const snapshotPrograms = (h: ReturnType<typeof harness>, conn: string) => {
    const snap = h.subscribe(conn).find((e) => e.kind === "send" && e.msg.t === "snapshot");
    if (snap?.kind !== "send" || snap.msg.t !== "snapshot") throw new Error("no snapshot");
    return (snap.msg.programs ?? []).map((p) => p.name);
  };

  test("a retired program is announced, leaves the snapshot, and is dropped once nothing refers to it", () => {
    const h = harness();
    h.addProgram("tiles");
    h.subscribe("obs");
    const effects = h.event({ kind: "programRetired", bundle: BUNDLE });
    const told = effects.find((e) => e.kind === "send" && e.msg.t === "programRetired");
    if (told?.kind !== "send" || told.msg.t !== "programRetired") throw new Error("not announced");
    expect(told.msg.name).toBe("demo");
    expect(snapshotPrograms(h, "late")).toEqual([]);
    expect(h.ledger.programs.has(BUNDLE)).toBe(false);
    // Retiring what is not there, or twice, is nothing.
    expect(h.event({ kind: "programRetired", bundle: BUNDLE })).toEqual([]);
  });

  test("kept while an execution refers to it, hidden and refusing launches; pruning drops it", () => {
    const h = harness();
    h.hello("a", "h1");
    h.addProgram("tiles");
    h.subscribe("obs");
    h.launch({ preset: 0 }, true);
    h.event({ kind: "programRetired", bundle: BUNDLE });
    expect(h.ledger.programs.get(BUNDLE)?.retired).toBe(true);
    expect(snapshotPrograms(h, "late")).toEqual([]);
    const refused = h.event({
      kind: "launch",
      bundle: BUNDLE,
      params: {},
      human: true,
      inherit: null,
      connId: "obs",
    });
    const err = refused.find((e) => e.kind === "send" && e.msg.t === "error");
    if (err?.kind !== "send" || err.msg.t !== "error") throw new Error("not refused");
    expect(err.msg.message).toContain("program retired");
    // The running frame still gets its work: fill needs the module.
    expect(h.ledger.running).not.toBeNull();
    expect(h.invariants()).toEqual([]);
    // Once no execution refers to the bundle, the prune drops the record.
    h.ledger.executions.clear();
    h.ledger.running = null;
    h.ledger.queue = [];
    h.ledger.tasks.clear();
    for (const n of h.ledger.nodes.values()) n.inFlight = [];
    pruneExecutions(h.ledger);
    expect(h.ledger.programs.has(BUNDLE)).toBe(false);
  });

  test("setDefaultLoop moves the machine's loop: the old bundle's chain ends and the new one takes over", () => {
    const h = harness({ defaultLoop: { bundle: BUNDLE, params: { preset: 0 } } });
    h.subscribe("obs");
    h.hello("a", "h1");
    h.addProgram("tiles"); // the loop launches it as soon as it exists
    const first = [...h.ledger.executions.values()][0];
    if (!first) throw new Error("the loop did not launch");
    expect(first.human).toBe(false);
    expect(first.bundle).toBe(BUNDLE);
    const NEXT = H("c");
    h.event({
      kind: "programAdded",
      bundle: NEXT,
      module: H("d"),
      manifest: { name: "demo", view: "tiles", persist: false, defaultParams: { preset: 1 } },
      files: {},
    });
    h.event({ kind: "programRetired", bundle: BUNDLE });
    h.event({ kind: "setDefaultLoop", loop: { bundle: NEXT, params: { preset: 1 } } });
    expect(h.ledger.config.defaultLoop?.bundle).toBe(NEXT);
    // The old frame finishes with a follow-up of its own; it is not queued, the new bundle is.
    h.tick();
    const plan = planAssignOf(h, first.executionId);
    h.planSpec(h.result(plan.connId, plan.taskId, plan.attempt, H("e")), {
      kind: "done",
      next: { preset: 7 },
    });
    expect(first.status).toBe("done");
    h.tick(); // the loop launches on the tick after the queue empties
    const after = [...h.ledger.executions.values()].filter(
      (e) => e.executionId !== first.executionId,
    );
    expect(after.map((e) => e.bundle)).toEqual([NEXT]);
    expect(after[0]?.params).toEqual({ preset: 1 });
    expect(h.ledger.programs.has(BUNDLE)).toBe(true); // still referenced by the finished frame
    expect(h.invariants()).toEqual([]);
  });
});
