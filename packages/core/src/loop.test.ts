import { describe, expect, test } from "bun:test";
import { RELEASED } from "@tabframe/protocol";
import type { Effect } from "./events.ts";
import { BUNDLE, H, type Harness, harness, renderSpec } from "./harness.ts";
import { LOOP_BACKOFF_MAX_MS, LOOP_BACKOFF_MIN_MS, YIELD_IDLE_MS } from "./policy.ts";
import { deserializeLedger, serializeLedger } from "./snapshot.ts";

/** The machine's default loop (D4, D19, design §6.7): backoff after failures, and yielding to people. */

describe("default loop backoff", () => {
  test("a failed loop execution pauses the relaunch; the pause doubles; a success resets it", () => {
    const h = harness({ defaultLoop: { bundle: BUNDLE, params: { preset: 0 } } });
    h.subscribe("obs");
    h.hello("a", "h1");
    h.addProgram("tiles"); // programAdded → the loop launches e1
    const failRunning = (): number => {
      const exec = [...h.ledger.executions.values()].find((e) => e.status === "running");
      if (!exec) throw new Error("nothing running");
      h.tick(); // make sure the plan task is assigned
      const plan = h.planAssign(exec.executionId);
      const before = h.now;
      h.resultError(plan.connId, plan.taskId, plan.attempt, "trap: boom");
      expect(exec.status).toBe("failed");
      return h.ledger.meta.loopPausedUntil - before;
    };
    /** Let time pass while the node heartbeats and the observer pings, so neither is dropped. */
    const wait = (ms: number): void => {
      for (let left = ms; left > 0; left -= 1_000) {
        h.advance(Math.min(1_000, left));
        h.heartbeat("a");
        h.send("obs", { t: "ping" });
        h.tick();
      }
    };
    expect(h.ledger.running).not.toBeNull();
    expect(failRunning()).toBe(LOOP_BACKOFF_MIN_MS);
    // Nothing relaunches while paused.
    expect(h.tick().some((e) => e.kind === "send" && e.msg.t === "executionQueued")).toBe(false);
    expect(h.ledger.running).toBeNull();
    wait(LOOP_BACKOFF_MIN_MS - 1_000);
    expect(h.ledger.running).toBeNull(); // still paused
    wait(1_000);
    expect(h.ledger.running).not.toBeNull();
    // The second failure doubles the pause.
    expect(failRunning()).toBe(LOOP_BACKOFF_MIN_MS * 2);
    wait(LOOP_BACKOFF_MIN_MS * 2);
    // A successful execution resets the backoff.
    const exec = [...h.ledger.executions.values()].find((e) => e.status === "running");
    if (!exec) throw new Error("nothing running");
    const plan = h.planAssign(exec.executionId);
    const stage = h.planSpec(
      h.result(plan.connId, plan.taskId, plan.attempt, H("e")),
      renderSpec(1),
    );
    const run = h.assigns(stage).find((a) => a.kind === "run");
    if (!run) throw new Error("no run");
    h.manifestStored(h.result(run.connId, run.taskId, run.attempt, H("1")));
    // the folded stage creates the next plan task, whose spec says done
    const next = h.planAssign(exec.executionId);
    h.planSpec(h.result(next.connId, next.taskId, next.attempt, H("f")), {
      kind: "done",
      next: null,
    });
    expect(exec.status).toBe("done");
    expect(h.ledger.meta.loopBackoffMs).toBe(0);
    expect(h.invariants()).toEqual([]);
  });

  test("the pause is capped and released results do not count as failures", () => {
    const h = harness({ defaultLoop: { bundle: BUNDLE, params: { preset: 0 } } });
    h.subscribe("obs");
    h.hello("a", "h1");
    h.addProgram("tiles");
    h.ledger.meta.loopBackoffMs = LOOP_BACKOFF_MAX_MS;
    const exec = [...h.ledger.executions.values()][0];
    if (!exec) throw new Error("no execution");
    const plan = h.planAssign(exec.executionId);
    h.resultError(plan.connId, plan.taskId, plan.attempt, RELEASED);
    expect(exec.status).toBe("running");
    h.resultError(plan.connId, plan.taskId, plan.attempt + 1, "trap");
    expect(exec.status).toBe("failed");
    expect(h.ledger.meta.loopBackoffMs).toBe(LOOP_BACKOFF_MAX_MS);
  });

  test("human executions never touch the backoff", () => {
    const h = harness({ defaultLoop: { bundle: BUNDLE, params: { preset: 0 } } });
    h.hello("a", "h1");
    h.addProgram("tiles"); // no observer: the loop stays quiet
    h.launch({ preset: 3 }, true);
    const exec = [...h.ledger.executions.values()][0];
    if (!exec) throw new Error("no execution");
    const plan = h.planAssign(exec.executionId);
    h.resultError(plan.connId, plan.taskId, plan.attempt, "trap");
    expect(exec.status).toBe("failed");
    expect(h.ledger.meta.loopBackoffMs).toBe(0);
  });

  test("old snapshots without the fields deserialize with zeros", () => {
    const h = harness();
    const json = JSON.parse(serializeLedger(h.ledger)) as { meta: Record<string, unknown> };
    delete json.meta.loopBackoffMs;
    delete json.meta.loopPausedUntil;
    const back = deserializeLedger(JSON.stringify(json));
    expect(back.meta.loopBackoffMs).toBe(0);
    expect(back.meta.loopPausedUntil).toBe(0);
  });
});

describe("the loop yields to people", () => {
  const alive = (h: Harness) => {
    h.heartbeat("a");
    h.send("obs", { t: "ping" });
  };
  const finishPlanOf = (h: Harness, id: string, next: Record<string, unknown> | null) => {
    const plan = h.planAssign(id);
    return h.planSpec(h.result(plan.connId, plan.taskId, plan.attempt, H("e")), {
      kind: "done",
      next,
    });
  };
  const said = (effects: Effect[], yielded: boolean) =>
    effects.some(
      (e) => e.kind === "send" && e.msg.t === "loopYielded" && e.msg.yielded === yielded,
    );

  test("the yield and its release are announced to observers (loopYielded)", () => {
    const h = harness({ defaultLoop: { bundle: BUNDLE, params: { preset: 0 } } });
    h.subscribe("obs");
    h.hello("a", "h1");
    h.addProgram("tiles"); // e1, the loop's
    h.tick();
    h.launch({ preset: 5 }, true); // e2, a person's
    finishPlanOf(h, "e1", { preset: 1 }); // e2 starts; e3, the continuation, waits
    const ended = finishPlanOf(h, "e2", null);
    expect(said(ended, true)).toBe(true);
    expect(h.ledger.meta.loopYielded).toBe(true);
    h.send("obs", { t: "resumeAll" }); // an interaction: the quiet minutes count from here
    let released: Effect[] = [];
    for (let t = 0; t <= YIELD_IDLE_MS + 5_000 && released.length === 0; t += 1_000) {
      h.advance(1_000);
      alive(h);
      const fx = h.tick();
      if (said(fx, false)) released = fx;
    }
    expect(released.length).toBeGreaterThan(0);
    expect(h.ledger.meta.loopYielded).toBe(false);
    expect(h.ledger.running).toBe("e3");
    expect(h.invariants()).toEqual([]);
  });

  test("after a person's launch ends the loop stays out until Start", () => {
    const h = harness({ defaultLoop: { bundle: BUNDLE, params: { preset: 0 } } });
    h.subscribe("obs");
    h.hello("a", "h1");
    h.addProgram("tiles"); // the loop launches e1
    h.tick();
    h.launch({ preset: 5 }, true); // e2 queued ahead of continuations
    finishPlanOf(h, "e1", { preset: 1 }); // e1 done offering e3; e2 starts
    expect(h.ledger.running).toBe("e2");
    expect(h.ledger.queue).toEqual(["e3"]);
    h.tick();
    finishPlanOf(h, "e2", null);
    expect(h.ledger.executions.get("e2")?.status).toBe("done");
    expect(h.ledger.meta.loopYielded).toBe(true);
    // Minutes of pings and heartbeats change nothing: pings are not interaction, and the loop's
    // queued continuation waits too.
    for (let t = 0; t < 5 * 60_000; t += 1_000) {
      h.advance(1_000);
      alive(h);
      h.tick();
    }
    expect(h.ledger.running).toBeNull();
    expect(h.ledger.executions.get("e3")?.status).toBe("queued");
    const snap = h.subscribe("late").find((e) => e.kind === "send" && e.msg.t === "snapshot");
    if (snap?.kind !== "send" || snap.msg.t !== "snapshot") throw new Error("no snapshot");
    expect(snap.msg.machine?.yielded).toBe(true);
    // Start gives the stage back to the loop at once.
    h.send("obs", { t: "start" });
    expect(h.ledger.meta.loopYielded).toBe(false);
    expect(h.ledger.running).toBe("e3");
    expect(h.invariants()).toEqual([]);
  });

  test("ten minutes without anyone touching the page and the loop comes back by itself", () => {
    const h = harness({ defaultLoop: { bundle: BUNDLE, params: { preset: 0 } } });
    h.subscribe("obs");
    h.hello("a", "h1");
    h.addProgram("tiles");
    h.tick();
    finishPlanOf(h, "e1", null); // the loop's own frame ends without a follow-up; not a yield
    expect(h.ledger.meta.loopYielded).toBe(false);
    h.tick();
    expect(h.ledger.running).toBe("e2"); // the loop went on
    h.launch({ preset: 7 }, true); // e3, a person's, queued behind e2
    finishPlanOf(h, "e2", null);
    expect(h.ledger.running).toBe("e3");
    finishPlanOf(h, "e3", null);
    expect(h.ledger.meta.loopYielded).toBe(true);
    // A control touches the page; the clock restarts from it.
    h.send("obs", { t: "resumeAll" });
    for (let t = 0; t < YIELD_IDLE_MS - 1_000; t += 1_000) {
      h.advance(1_000);
      alive(h);
      h.tick();
    }
    expect(h.ledger.running).toBeNull();
    h.advance(1_000);
    alive(h);
    h.tick();
    expect(h.ledger.meta.loopYielded).toBe(false);
    expect(h.ledger.running).not.toBeNull();
    expect(h.invariants()).toEqual([]);
  });
});
