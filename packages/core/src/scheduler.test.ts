import { describe, expect, test } from "bun:test";
import { LIMITS, RELEASED } from "@tabframe/protocol";
import { doneSpec, eventsOf, H, harness } from "./harness.ts";
import { COMPUTE_MS_REPORT_CAP } from "./policy.ts";

/** Scheduling (design §6.3, §6.4): fill, the three tiers, deadlines, and speculation. */

describe("fill", () => {
  test("a plan task starts the execution; the spec materializes tasks and fills every free slot", () => {
    const h = harness();
    const spec = h.stage(2, 6);
    const a = h.assigns(spec);
    expect(a.length).toBe(2 * LIMITS.maxInFlight);
    expect(new Set(a.map((x) => x.taskId)).size).toBe(4);
    expect(eventsOf(spec, "o1")).toContain("stageStarted");
    expect(h.ledger.executions.get("e1")?.counters).toMatchObject({ pending: 2, assigned: 4 });
    expect(h.invariants()).toEqual([]);
  });

  test("results refill the slot, complete the stage, fold, and finish the execution", () => {
    const h = harness();
    const spec = h.stage(1, 3);
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
    const h = harness();
    const spec = h.stage(2, 8);
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
    const h = harness();
    const spec = h.stage(1, 4);
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
    const h = harness();
    const spec = h.stage(2, 2);
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
    const h = harness();
    const spec = h.stage(1, 6);
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

describe("deadlines under releases", () => {
  test("a released task comes back with a doubled deadline, three doublings at most", () => {
    const h = harness();
    const runs = h.assigns(h.stage(1, 1));
    const first = runs[0] as (typeof runs)[number];
    let assign = first;
    const seen = [first.deadlineMs];
    for (let i = 0; i < 5; i++) {
      const effects = h.resultError(assign.connId, assign.taskId, assign.attempt, RELEASED);
      const next = [...h.assigns(effects), ...h.assigns(h.tick())].find(
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
    const h = harness();
    const runs = h.assigns(h.stage(1, 1));
    const a = runs[0] as (typeof runs)[number];
    h.disconnect(a.connId);
    const task = h.ledger.tasks.get(a.taskId);
    expect(task?.attempts.map((x) => x.outcome)).toEqual(["lost"]);
    expect(task?.status).toBe("pending");
    // A new node gets it at the base deadline: no release happened.
    const effects = h.hello("c2", "h2");
    const again = [...h.assigns(effects), ...h.assigns(h.tick())].find(
      (x) => x.taskId === a.taskId,
    );
    expect(again?.deadlineMs).toBe(a.deadlineMs);
  });
});
