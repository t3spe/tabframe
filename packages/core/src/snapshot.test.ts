import { describe, expect, test } from "bun:test";
import { H, harness, renderSpec } from "./harness.ts";
import { checkInvariants } from "./invariants.ts";
import { adoptLedger, deserializeLedger, serializeLedger } from "./snapshot.ts";

describe("ledger snapshot", () => {
  test("serializes and restores executions, tasks, programs, and meta; connections are dropped", () => {
    const h = harness();
    h.addProgram();
    h.subscribe("o1");
    h.hello("c1");
    const launched = h.launch();
    const plan = h.assigns(launched)[0];
    if (!plan) throw new Error("no plan");
    const spec = h.planSpec(
      h.result(plan.connId, plan.taskId, plan.attempt, H("a")),
      renderSpec(3),
    );
    expect(h.assigns(spec).length).toBe(2);
    const json = serializeLedger(h.ledger);
    const back = deserializeLedger(json);
    expect(back.meta).toEqual(h.ledger.meta);
    expect(back.programs.size).toBe(1);
    expect(back.executions.get("e1")?.stageTaskIds.length).toBe(3);
    expect(back.tasks.size).toBe(4);
    expect(back.tasks.get("t2")?.input).toEqual(new Uint8Array([0]));
    expect(back.nodes.size).toBe(1);
    expect(back.conns.size).toBe(0);
    expect(back.observers.size).toBe(0);
    expect(back.running).toBe("e1");
  });

  test("adopting releases every attempt and clears nodes; the work waits at the front for new cores", () => {
    const h = harness();
    h.addProgram();
    h.subscribe("o1");
    h.hello("c1");
    const plan = h.assigns(h.launch())[0];
    if (!plan) throw new Error("no plan");
    h.planSpec(h.result(plan.connId, plan.taskId, plan.attempt, H("a")), renderSpec(3));
    const restored = deserializeLedger(serializeLedger(h.ledger));
    adoptLedger(restored, 7, 5_000_000);
    expect(restored.meta.generation).toBe(7);
    expect(restored.nodes.size).toBe(0);
    for (const t of restored.tasks.values()) {
      if (t.kind === "run") expect(t.status).toBe("pending");
      expect(t.attempts.every((a) => a.outcome !== "running")).toBe(true);
    }
    expect(restored.executions.get("e1")?.counters.reassigned).toBe(2);
    expect(checkInvariants(restored)).toEqual([]);
  });

  test("rejects an unknown version", () => {
    expect(() => deserializeLedger(JSON.stringify({ version: 2 }))).toThrow(/version/);
  });
});

describe("invariants checker", () => {
  test("reports a broken ledger", () => {
    const h = harness();
    h.hello("c1");
    const node = h.ledger.nodes.get("n1");
    if (!node) throw new Error("no node");
    node.inFlight.push("ghost");
    expect(checkInvariants(h.ledger).some((v) => v.includes("ghost"))).toBe(true);
    node.inFlight = [];
    h.ledger.queue.push("e404");
    expect(checkInvariants(h.ledger).some((v) => v.includes("e404"))).toBe(true);
  });
});
