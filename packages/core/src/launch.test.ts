import { describe, expect, test } from "bun:test";
import { BUNDLE, defaultBundleFiles, H, harness, MODULE, renderSpec } from "./harness.ts";

/** The launch path (design §5.2, §6.7): uploads, priority, budgets, rates, follow-ups. */

const codeOf = (effects: Array<{ kind: string }>): string | null => {
  const e = effects.find((x) => x.kind === "send") as
    | { kind: "send"; msg: { t: string; code?: string } }
    | undefined;
  return e?.msg.t === "error" ? (e.msg.code ?? null) : null;
};

describe("uploads", () => {
  test("a launch of an unknown bundle asks the process to resolve it, then runs it", () => {
    const h = harness();
    h.subscribe("obs");
    h.hello("a", "h1");
    const asked = h.send("obs", { t: "launch", bundle: BUNDLE, params: { preset: 2 } });
    expect(asked).toEqual([
      {
        kind: "resolveBundle",
        bundle: BUNDLE,
        connId: "obs",
        params: { preset: 2 },
        inherit: null,
      },
    ]);
    expect(h.ledger.executions.size).toBe(0);
    // The process validated it: the program is registered and the same launch replayed.
    h.addProgram("tiles");
    const started = h.event({
      kind: "launch",
      bundle: BUNDLE,
      params: { preset: 2 },
      human: true,
      inherit: null,
      connId: "obs",
    });
    const exec = [...h.ledger.executions.values()][0];
    expect(exec?.params).toEqual({ preset: 2 });
    expect(exec?.human).toBe(true);
    expect(started.some((e) => e.kind === "send" && e.msg.t === "executionStarted")).toBe(true);
    // A known bundle launches straight away next time.
    expect(
      h.send("obs", { t: "launch", bundle: BUNDLE, params: {} }).some((e) => e.kind === "send"),
    ).toBe(true);
  });

  test("a rejected bundle tells the observer that asked, and nobody else", () => {
    const h = harness();
    h.subscribe("obs");
    h.subscribe("other");
    h.send("obs", { t: "launch", bundle: BUNDLE, params: {} });
    const effects = h.event({
      kind: "bundleRejected",
      bundle: BUNDLE,
      connId: "obs",
      reason: "forbidden imports: env.now",
    });
    expect(effects.length).toBe(1);
    expect(effects[0]).toMatchObject({ kind: "send", connId: "obs" });
    expect(codeOf(effects)).toBe("launch-refused");
    // A rejection for a connection that has gone is dropped.
    h.disconnect("obs");
    expect(
      h.event({ kind: "bundleRejected", bundle: BUNDLE, connId: "obs", reason: "late" }),
    ).toEqual([]);
  });

  test("a launch that the ledger itself refuses is reported to the observer", () => {
    const h = harness();
    h.subscribe("obs");
    h.addProgram("tiles");
    const effects = h.event({
      kind: "launch",
      bundle: BUNDLE,
      params: {},
      human: true,
      inherit: "e404",
      connId: "obs",
    });
    expect(codeOf(effects)).toBe("launch-refused");
  });
});

describe("budgets and rates", () => {
  test("an observer may launch only so often", () => {
    const h = harness({ launchesPerMinute: 2 });
    h.subscribe("obs");
    h.addProgram("tiles");
    expect(codeOf(h.send("obs", { t: "launch", bundle: BUNDLE, params: {} }))).toBeNull();
    expect(codeOf(h.send("obs", { t: "launch", bundle: BUNDLE, params: {} }))).toBeNull();
    expect(codeOf(h.send("obs", { t: "launch", bundle: BUNDLE, params: {} }))).toBe("rate-limited");
    // Another observer has its own allowance, and the window slides.
    h.subscribe("two");
    expect(codeOf(h.send("two", { t: "launch", bundle: BUNDLE, params: {} }))).toBeNull();
    h.advance(60_001);
    expect(codeOf(h.send("obs", { t: "launch", bundle: BUNDLE, params: {} }))).toBeNull();
    expect(h.ledger.executions.size).toBe(4);
  });

  test("follow-ups count against the same allowance", () => {
    const h = harness({ launchesPerMinute: 1 });
    h.subscribe("obs");
    h.addProgram("tiles");
    h.send("obs", { t: "launch", bundle: BUNDLE, params: {} });
    expect(codeOf(h.send("obs", { t: "runFollowUp", executionId: "e1" }))).toBe("rate-limited");
  });

  test("a stage over the task cap fails the execution with both numbers", () => {
    const h = harness({ taskCap: 10 });
    h.subscribe("obs");
    h.hello("a", "h1");
    h.addProgram("tiles");
    const launched = h.launch();
    const exec = [...h.ledger.executions.values()][0];
    if (!exec) throw new Error("no execution");
    const plan = h.assigns(launched).find((a) => a.kind === "plan");
    if (!plan) throw new Error("no plan assign");
    const effects = h.planSpec(
      h.result(plan.connId, plan.taskId, plan.attempt, H("e")),
      renderSpec(20),
    );
    expect(exec.status).toBe("failed");
    expect(exec.failure).toContain("cap is 10");
    expect(effects.some((e) => e.kind === "send" && e.msg.t === "executionFailed")).toBe(true);
    expect(h.invariants()).toEqual([]);
  });

  test("the plan task counts against the cap too", () => {
    const h = harness({ taskCap: 3 });
    h.hello("a", "h1");
    h.addProgram("tiles");
    h.launch();
    const exec = [...h.ledger.executions.values()][0];
    expect(exec?.tasksCreated).toBe(1);
  });
});

describe("priority and program records", () => {
  test("human launches go ahead of automatic continuations", () => {
    const h = harness({ defaultLoop: { bundle: BUNDLE, params: { preset: 0 } } });
    h.subscribe("obs");
    h.hello("a", "h1");
    h.addProgram("tiles"); // the loop starts e1 and nothing is queued
    h.event({ kind: "launch", bundle: BUNDLE, params: { preset: 9 }, human: false, inherit: null });
    h.event({ kind: "launch", bundle: BUNDLE, params: { preset: 8 }, human: false, inherit: null });
    h.send("obs", { t: "launch", bundle: BUNDLE, params: { preset: 7 } });
    const queued = h.ledger.queue.map((id) => h.ledger.executions.get(id)?.params.preset);
    expect(queued).toEqual([7, 9, 8]);
  });

  test("a program record keeps the module and the bundle's files", () => {
    const h = harness();
    h.addProgram("bars");
    const program = h.ledger.programs.get(BUNDLE);
    expect(program?.module).toBe(MODULE);
    expect(program?.files).toEqual(defaultBundleFiles);
    expect(program?.manifest.view).toBe("bars");
  });
});
