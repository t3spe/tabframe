import { describe, expect, test } from "bun:test";
import { BUNDLE, eventsOf, H, type Harness, harness, renderSpec } from "./harness.ts";
import { CONTROL_COOLDOWN_MS } from "./policy.ts";
import { adoptLedger, deserializeLedger, serializeLedger } from "./snapshot.ts";

/** The observer's controls (design §6.7): what each one ends, holds, or starts. */

const alive = (h: Harness) => {
  h.heartbeat("a");
  h.send("obs", { t: "ping" });
};

describe("cooldown", () => {
  test("a destructive control is refused within the cooldown, machine-wide", () => {
    const h = harness();
    h.addProgram();
    h.subscribe("o1");
    h.subscribe("o2");
    h.hello("c1", "h1");
    h.hello("c2", "h2");
    expect(
      h
        .send("o1", { t: "freezeHalf" })
        .some((e) => e.kind === "send" && e.msg.t === "controlApplied"),
    ).toBe(true);
    const again = h.send("o2", { t: "freezeHalf" });
    expect(
      again.some((e) => e.kind === "send" && e.msg.t === "error" && e.msg.code === "cooldown"),
    ).toBe(true);
    h.advance(CONTROL_COOLDOWN_MS + 1);
    expect(
      h
        .send("o2", { t: "resumeAll" })
        .some((e) => e.kind === "send" && e.msg.t === "controlApplied"),
    ).toBe(true);
  });
});

describe("redundancy off", () => {
  test("open tasks need one result, and one that already holds a result settles on it", () => {
    const h = harness();
    h.addProgram();
    h.subscribe("o1");
    h.send("o1", { t: "setRedundancy", on: true });
    h.hello("c1", "h1");
    const launched = h.launch({ preset: 1 }, true);
    const plans = h.assigns(launched);
    expect(plans.length).toBe(1); // one node: the twin waits
    const [plan] = plans;
    if (!plan) throw new Error("no plan");
    h.result(plan.connId, plan.taskId, plan.attempt, H("a"));
    expect(h.ledger.tasks.get(plan.taskId)?.status).not.toBe("done"); // waiting for a twin that never comes
    h.advance(2_000); // the redundancy flip is a destructive control: one per two seconds
    const off = h.send("o1", { t: "setRedundancy", on: false });
    expect(h.ledger.tasks.get(plan.taskId)?.status).toBe("done");
    expect(off.some((e) => e.kind === "fetchBlob" && e.purpose.type === "stageSpec")).toBe(true);
  });
});

/** A person pressed Stop: the machine goes idle and stays idle until Start. */
describe("stop and start", () => {
  test("stop ends the running frame, drops the loop's queued continuation, keeps a person's launch, and holds the loop", () => {
    const h = harness({ defaultLoop: { bundle: BUNDLE, params: { preset: 0 } } });
    h.subscribe("obs");
    h.hello("a", "h1");
    h.addProgram("tiles"); // the loop launches e1
    h.tick();
    expect(h.ledger.running).toBe("e1");
    // A queued continuation and a queued human launch.
    h.event({ kind: "launch", bundle: BUNDLE, params: { preset: 3 }, human: false, inherit: null });
    h.launch({ preset: 7 }, true);
    expect(h.ledger.queue).toEqual(["e3", "e2"]);
    const effects = h.send("obs", { t: "stop" });
    expect(
      effects.some((e) => e.kind === "send" && e.msg.t === "controlApplied" && e.msg.op === "stop"),
    ).toBe(true);
    expect(h.ledger.meta.loopStopped).toBe(true);
    expect(h.ledger.executions.get("e1")?.status).toBe("cancelled");
    expect(h.ledger.executions.get("e2")?.status).toBe("cancelled"); // the loop's continuation
    // The person's launch was next in line and runs; the loop does not follow it.
    expect(h.ledger.running).toBe("e3");
    const plan = h.planAssign("e3");
    h.planSpec(h.result(plan.connId, plan.taskId, plan.attempt, H("e")), {
      kind: "done",
      next: { preset: 8 },
    });
    expect(h.ledger.executions.get("e3")?.status).toBe("done");
    for (let i = 0; i < 30; i++) {
      h.advance(1_000);
      alive(h);
      h.tick();
    }
    expect(h.ledger.running).toBeNull();
    expect(h.ledger.queue).toEqual([]);
    // The snapshot says so, and a snapshot round trip keeps it.
    const snap = h.subscribe("late").find((e) => e.kind === "send" && e.msg.t === "snapshot");
    if (snap?.kind !== "send" || snap.msg.t !== "snapshot") throw new Error("no snapshot");
    expect(snap.msg.machine?.stopped).toBe(true);
    expect(deserializeLedger(serializeLedger(h.ledger)).meta.loopStopped).toBe(true);
    expect(h.invariants()).toEqual([]);
  });

  test("start lets the loop run again at once, hold or backoff notwithstanding", () => {
    const h = harness({ defaultLoop: { bundle: BUNDLE, params: { preset: 0 } } });
    h.subscribe("obs");
    h.hello("a", "h1");
    h.addProgram("tiles");
    h.tick();
    h.send("obs", { t: "stop" });
    expect(h.ledger.running).toBeNull();
    h.ledger.meta.loopPausedUntil = h.now + 60_000; // as after a person's launch, or a failure
    const effects = h.send("obs", { t: "start" });
    expect(
      effects.some(
        (e) => e.kind === "send" && e.msg.t === "controlApplied" && e.msg.op === "start",
      ),
    ).toBe(true);
    expect(h.ledger.meta.loopStopped).toBe(false);
    expect(h.ledger.running).not.toBeNull();
    expect(h.ledger.executions.get(h.ledger.running as string)?.human).toBe(false);
    expect(h.invariants()).toEqual([]);
  });

  test("stop with nothing running is just the hold; a person's launch still runs while stopped", () => {
    const h = harness();
    h.subscribe("obs");
    h.hello("a", "h1");
    h.addProgram("tiles");
    h.send("obs", { t: "stop" });
    expect(h.ledger.meta.loopStopped).toBe(true);
    h.launch({ preset: 1 }, true);
    expect(h.ledger.running).toBe("e1");
    expect(h.invariants()).toEqual([]);
  });
});

/** An editor tab holds the machine paused: nothing new is assigned or started. */
describe("pause and resume", () => {
  test("pause freezes assignment and starts; resume continues the same execution", () => {
    const h = harness();
    h.subscribe("obs");
    h.hello("a", "h1");
    h.addProgram("tiles");
    h.launch({ preset: 0 }, true);
    h.tick();
    const plan = h.planAssign("e1");
    h.connect("editor", "observer");
    h.send("editor", { t: "subscribe" });
    const paused = h.send("editor", { t: "pause" });
    expect(
      paused.some((e) => e.kind === "send" && e.msg.t === "controlApplied" && e.msg.op === "pause"),
    ).toBe(true);
    expect(h.ledger.session.pausedBy).toBe("editor");
    // The plan result lands and the stage is created, but no tile is handed out.
    const stage = h.planSpec(
      h.result(plan.connId, plan.taskId, plan.attempt, H("e")),
      renderSpec(3),
    );
    expect(h.assigns(stage)).toEqual([]);
    expect(h.assigns(h.tick())).toEqual([]);
    expect(h.ledger.running).toBe("e1");
    // A second pause from the same tab is one pause; the snapshot says paused.
    expect(h.send("editor", { t: "pause" })).toEqual([]);
    const snap = h.subscribe("late").find((e) => e.kind === "send" && e.msg.t === "snapshot");
    if (snap?.kind !== "send" || snap.msg.t !== "snapshot") throw new Error("no snapshot");
    expect(snap.msg.machine?.paused).toBe(true);
    // Resume from the dashboard: the tiles go out at once.
    const resumed = h.send("obs", { t: "resume" });
    expect(h.ledger.session.pausedBy).toBeNull();
    expect(h.assigns(resumed).length).toBeGreaterThan(0);
    expect(h.invariants()).toEqual([]);
  });

  test("the holder's socket going away lifts the pause; adoption clears it too", () => {
    const h = harness({ defaultLoop: { bundle: BUNDLE, params: { preset: 0 } } });
    h.subscribe("obs");
    h.hello("a", "h1");
    h.connect("editor", "observer");
    h.send("editor", { t: "subscribe" });
    h.send("editor", { t: "pause" });
    h.addProgram("tiles"); // the loop would launch now; it waits
    h.tick();
    expect(h.ledger.running).toBeNull();
    const gone = h.disconnect("editor");
    expect(
      gone.some((e) => e.kind === "send" && e.msg.t === "controlApplied" && e.msg.op === "resume"),
    ).toBe(true);
    expect(h.ledger.session.pausedBy).toBeNull();
    expect(h.ledger.running).not.toBeNull();
    // A pause never survives a rotation: the holder is on the previous generation's sockets.
    h.connect("editor2", "observer");
    h.send("editor2", { t: "subscribe" });
    h.send("editor2", { t: "pause" });
    expect(h.ledger.session.pausedBy).toBe("editor2");
    const restored = deserializeLedger(serializeLedger(h.ledger));
    expect(restored.session.pausedBy).toBeNull();
    adoptLedger(h.ledger, 9, h.now);
    expect(h.ledger.session.pausedBy).toBeNull();
    expect(h.invariants()).toEqual([]);
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
    const h = harness();
    const spec = h.stage(2, 6);
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
    const h = harness();
    h.stage(1, 2);
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
    // A bundle the ledger does not know is an upload: the process is asked to resolve it.
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
});
