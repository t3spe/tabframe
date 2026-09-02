import { describe, expect, test } from "bun:test";
import { CLOSE, type RotatingReason } from "@tabframe/protocol";
import { beginHandover, drain, JITTER_FLOOR_MS, jitterWindowMs } from "./handover.ts";
import { BUNDLE, H, harness, renderSpec } from "./harness.ts";
import { adoptLedger, deserializeLedger } from "./snapshot.ts";

/** The control plane's half of a rotation (design §9.4). */
describe("handover", () => {
  test("stops assigning and hands over a ledger the successor can adopt", () => {
    const h = harness();
    h.subscribe("obs");
    h.hello("a", "h1");
    h.hello("b", "h2");
    h.addProgram("tiles");
    const launched = h.launch();
    const plan = h.assigns(launched)[0];
    if (!plan) throw new Error("no plan assign");
    h.planSpec(h.result(plan.connId, plan.taskId, plan.attempt, H("e")), renderSpec(4));
    const assignedBefore = h.assigns(h.tick()).length + 1;
    expect(assignedBefore).toBeGreaterThan(0);

    const { json, generation } = beginHandover(h.ledger);
    expect(generation).toBe(h.ledger.meta.generation);
    expect(h.ledger.meta.phase).toBe("handing-over");
    // Nothing is assigned any more, however many ticks go by.
    expect(h.assigns(h.tick())).toEqual([]);
    h.advance(1_000);
    expect(h.assigns(h.tick())).toEqual([]);

    // The successor adopts it: every node is gone, their work released, generation stamped.
    const next = deserializeLedger(json);
    expect(next.meta.phase).toBe("active");
    expect(next.nodes.size).toBe(2);
    adoptLedger(next, generation + 1, 2_000_000);
    expect(next.meta.generation).toBe(generation + 1);
    expect(next.nodes.size).toBe(0);
    expect(next.meta.phase).toBe("active");
    expect(next.executions.size).toBe(h.ledger.executions.size);
    expect(next.tasks.size).toBe(h.ledger.tasks.size);
    const open = [...next.tasks.values()].filter((t) => t.status === "assigned");
    expect(open).toEqual([]);
    expect(next.programs.get(BUNDLE)?.module).toBe(h.ledger.programs.get(BUNDLE)?.module);
  });

  test("a second handover returns the same ledger", () => {
    const h = harness();
    h.hello("a", "h1");
    h.addProgram("tiles");
    const first = beginHandover(h.ledger);
    const second = beginHandover(h.ledger);
    expect(second.json).toBe(first.json);
    expect(second.generation).toBe(first.generation);
  });
});

describe("drain", () => {
  test("tells observers, then closes every client with its own delay inside the window", () => {
    const h = harness();
    h.subscribe("obs");
    h.hello("a", "h1");
    h.hello("b", "h2");
    const effects = drain(h.ledger, 7, h.rng);
    const rotating = effects.find((e) => e.kind === "send" && e.msg.t === "controlPlaneRotating");
    if (!rotating || rotating.kind !== "send" || rotating.msg.t !== "controlPlaneRotating")
      throw new Error("no rotating event");
    expect(rotating.msg.next).toBe(7);

    const closes = effects.filter((e) => e.kind === "close");
    expect(closes.length).toBe(3); // two nodes and the observer
    const window = jitterWindowMs(3);
    expect(window).toBe(JITTER_FLOOR_MS);
    for (const c of closes) {
      if (c.kind !== "close") throw new Error("not a close");
      expect(c.code).toBe(CLOSE.rotatingReconnect);
      const reason = JSON.parse(c.reason) as RotatingReason;
      expect(reason.next).toBe(7);
      expect(reason.gen).toBe(h.ledger.meta.generation);
      expect(reason.reconnectAfterMs).toBeGreaterThanOrEqual(0);
      expect(reason.reconnectAfterMs).toBeLessThanOrEqual(window);
      // The close reason must fit the WebSocket limit.
      expect(new TextEncoder().encode(c.reason).length).toBeLessThanOrEqual(123);
    }
    expect(h.ledger.meta.phase).toBe("drained");
  });

  test("the window is 30 ms per client with a two-second floor", () => {
    expect(jitterWindowMs(0)).toBe(JITTER_FLOOR_MS);
    expect(jitterWindowMs(60)).toBe(JITTER_FLOOR_MS);
    expect(jitterWindowMs(100)).toBe(3_000);
    expect(jitterWindowMs(300)).toBe(9_000);
  });

  test("delays spread across the window rather than landing together", () => {
    const h = harness();
    for (let i = 0; i < 40; i++) h.hello(`c${i}`, `h${i}`);
    const closes = drain(h.ledger, 2, h.rng).filter((e) => e.kind === "close");
    const delays = closes.map((c) =>
      c.kind === "close" ? (JSON.parse(c.reason) as RotatingReason).reconnectAfterMs : 0,
    );
    expect(delays.length).toBe(40);
    expect(new Set(delays).size).toBeGreaterThan(30);
    const window = jitterWindowMs(40);
    expect(Math.max(...delays)).toBeGreaterThan(window / 2);
    expect(Math.min(...delays)).toBeLessThan(window / 2);
  });
});
