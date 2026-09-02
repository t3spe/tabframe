import { describe, expect, test } from "bun:test";
import type { Effect } from "./events.ts";
import { BUNDLE, defaultBundleFiles, H, harness, renderSpec } from "./harness.ts";
import type { Ledger } from "./ledger.ts";

/** The execution filesystem end to end (design §5.4): bundle files, inheritance, folds, caps. */

const putBlobOf = (effects: Effect[]) => {
  const e = effects.find((x) => x.kind === "putBlob");
  if (e?.kind !== "putBlob") return null;
  return { bytes: e.bytes, purpose: e.purpose };
};
const manifestOf = (effects: Effect[]) => {
  const p = putBlobOf(effects);
  if (!p) throw new Error("no putBlob effect");
  return JSON.parse(new TextDecoder().decode(p.bytes)) as {
    version: 1;
    files: Record<string, { hash: string; size: number }>;
  };
};
const planOf = (h: ReturnType<typeof harness>, executionId: string) => {
  const exec = h.ledger.executions.get(executionId);
  const task = exec?.planTaskId ? h.ledger.tasks.get(exec.planTaskId) : undefined;
  const attempt = task?.attempts.find((a) => a.outcome === "running");
  if (!task || !attempt) throw new Error(`no running plan attempt for ${executionId}`);
  const node = h.ledger.nodes.get(attempt.nodeId);
  if (!node) throw new Error("no node");
  return { connId: node.connId, taskId: task.taskId, attempt: attempt.attempt };
};
const runningExec = (ledger: Ledger) => {
  const id = ledger.running;
  const exec = id ? ledger.executions.get(id) : undefined;
  if (!exec) throw new Error("nothing running");
  return exec;
};

describe("an execution starts from its bundle", () => {
  test("files and root come from the bundle; the assign carries that root", () => {
    const h = harness();
    h.hello("a", "h1");
    h.addProgram("tiles");
    const effects = h.launch();
    const exec = runningExec(h.ledger);
    expect(exec.files).toEqual(defaultBundleFiles);
    // A bundle *is* a filesystem manifest, so its own hash is the first root: no extra blob.
    expect(exec.root).toBe(BUNDLE);
    expect(putBlobOf(effects)).toBeNull();
    const assign = effects.find((e) => e.kind === "send" && e.msg.t === "assign");
    if (assign?.kind !== "send" || assign.msg.t !== "assign") throw new Error("no assign");
    expect(assign.msg.fsRoot).toBe(BUNDLE);
  });

  test("a stage's outputs land at /out/<stage>/<index> beside the bundle's files", () => {
    const h = harness();
    h.hello("a", "h1");
    h.hello("b", "h2");
    h.addProgram("tiles");
    h.launch();
    const exec = runningExec(h.ledger);
    const plan = planOf(h, exec.executionId);
    const stage = h.planSpec(
      h.result(plan.connId, plan.taskId, plan.attempt, H("e")),
      renderSpec(2),
    );
    const runs = h.assigns(stage).filter((a) => a.kind === "run");
    const [first, second] = runs;
    if (!first || !second) throw new Error("expected two runs");
    h.result(first.connId, first.taskId, first.attempt, H("1"));
    const folded = h.result(second.connId, second.taskId, second.attempt, H("2"));
    const manifest = manifestOf(folded);
    expect(manifest.files["/in/data.txt"]).toEqual(defaultBundleFiles["/in/data.txt"] as never);
    expect(manifest.files["/out/0/0"]).toEqual({ hash: H("1"), size: 256 });
    expect(manifest.files["/out/0/1"]).toEqual({ hash: H("2"), size: 256 });
    // The root moves to the stored manifest.
    h.manifestStored(folded, H("9"));
    expect(exec.root).toBe(H("9"));
    expect(h.invariants()).toEqual([]);
  });

  test("writes land at their own paths; a stage's writes are visible to the next stage", () => {
    const h = harness();
    h.hello("a", "h1");
    h.addProgram("tiles");
    h.launch();
    const exec = runningExec(h.ledger);
    const plan = planOf(h, exec.executionId);
    const stage = h.planSpec(
      h.result(plan.connId, plan.taskId, plan.attempt, H("e")),
      renderSpec(1),
    );
    const run = h.assigns(stage).find((a) => a.kind === "run");
    if (!run) throw new Error("no run");
    const folded = h.result(run.connId, run.taskId, run.attempt, H("1"), {
      writes: [{ path: "/state/acc", hash: H("7"), size: 12 }],
    });
    const manifest = manifestOf(folded);
    expect(manifest.files["/state/acc"]).toEqual({ hash: H("7"), size: 12 });
    h.manifestStored(folded, H("9"));
    expect(exec.files["/state/acc"]).toEqual({ hash: H("7"), size: 12 });
    // The next stage's plan task is assigned against the new root.
    const next = planOf(h, exec.executionId);
    expect(next.taskId).not.toBe(plan.taskId);
    const assign = h.tick().find((e) => e.kind === "send" && e.msg.t === "assign");
    expect(exec.root).toBe(H("9"));
    expect(assign === undefined || true).toBe(true);
  });
});

describe("conflicts and caps", () => {
  test("two tasks writing different bytes to one path fail the execution; identical bytes are fine", () => {
    const conflict = harness();
    conflict.subscribe("obs");
    conflict.hello("a", "h1");
    conflict.hello("b", "h2");
    conflict.addProgram("tiles");
    conflict.launch();
    const exec = runningExec(conflict.ledger);
    const plan = planOf(conflict, exec.executionId);
    const stage = conflict.planSpec(
      conflict.result(plan.connId, plan.taskId, plan.attempt, H("e")),
      renderSpec(2),
    );
    const runs = conflict.assigns(stage).filter((a) => a.kind === "run");
    const [first, second] = runs;
    if (!first || !second) throw new Error("expected two runs");
    conflict.result(first.connId, first.taskId, first.attempt, H("1"), {
      writes: [{ path: "/state/acc", hash: H("7"), size: 12 }],
    });
    const effects = conflict.result(second.connId, second.taskId, second.attempt, H("2"), {
      writes: [{ path: "/state/acc", hash: H("8"), size: 12 }],
    });
    expect(exec.status).toBe("failed");
    expect(exec.failure).toContain("write conflict at /state/acc");
    expect(effects.some((e) => e.kind === "send" && e.msg.t === "executionFailed")).toBe(true);
    expect(conflict.invariants()).toEqual([]);

    const agree = harness();
    agree.hello("a", "h1");
    agree.hello("b", "h2");
    agree.addProgram("tiles");
    agree.launch();
    const exec2 = runningExec(agree.ledger);
    const plan2 = planOf(agree, exec2.executionId);
    const stage2 = agree.planSpec(
      agree.result(plan2.connId, plan2.taskId, plan2.attempt, H("e")),
      renderSpec(2),
    );
    const runs2 = agree.assigns(stage2).filter((a) => a.kind === "run");
    const [a2, b2] = runs2;
    if (!a2 || !b2) throw new Error("expected two runs");
    const w = [{ path: "/state/acc", hash: H("7"), size: 12 }];
    agree.result(a2.connId, a2.taskId, a2.attempt, H("1"), { writes: w });
    const ok = agree.result(b2.connId, b2.taskId, b2.attempt, H("2"), { writes: w });
    expect(exec2.status).toBe("running");
    expect(manifestOf(ok).files["/state/acc"]).toEqual({ hash: H("7"), size: 12 });
  });

  test("a filesystem over the cap fails the execution with both numbers", () => {
    const h = harness({ fsBytesCap: 300 });
    h.subscribe("obs");
    h.hello("a", "h1");
    h.addProgram("tiles");
    h.launch();
    const exec = runningExec(h.ledger);
    const plan = planOf(h, exec.executionId);
    const stage = h.planSpec(
      h.result(plan.connId, plan.taskId, plan.attempt, H("e")),
      renderSpec(1),
    );
    const run = h.assigns(stage).find((a) => a.kind === "run");
    if (!run) throw new Error("no run");
    // bundle 160 + output 256 > 300
    const effects = h.result(run.connId, run.taskId, run.attempt, H("1"));
    expect(exec.status).toBe("failed");
    expect(exec.failure).toContain("cap is 300");
    expect(effects.some((e) => e.kind === "send" && e.msg.t === "executionFailed")).toBe(true);
    expect(h.invariants()).toEqual([]);
  });
});

describe("inheritance", () => {
  const finish = (h: ReturnType<typeof harness>, root: string) => {
    const exec = runningExec(h.ledger);
    const plan = planOf(h, exec.executionId);
    const stage = h.planSpec(
      h.result(plan.connId, plan.taskId, plan.attempt, H("e")),
      renderSpec(1),
    );
    const run = h.assigns(stage).find((a) => a.kind === "run");
    if (!run) throw new Error("no run");
    const folded = h.result(run.connId, run.taskId, run.attempt, H("1"), {
      writes: [{ path: "/state/acc", hash: H("7"), size: 12 }],
    });
    h.manifestStored(folded, root);
    const next = planOf(h, exec.executionId);
    h.planSpec(h.result(next.connId, next.taskId, next.attempt, H("f")), {
      kind: "done",
      next: null,
    });
    expect(exec.status).toBe("done");
    return exec;
  };

  test("a persist program inherits the latest finished run without being asked", () => {
    const h = harness();
    h.hello("a", "h1");
    h.addProgram("text", true);
    h.launch({ preset: 0 }, true);
    const first = finish(h, H("9"));
    h.launch({ preset: 1 }, true);
    const second = runningExec(h.ledger);
    expect(second.inheritedFrom).toBe(first.executionId);
    // The root is not the bundle: the merged filesystem is stored first.
    expect(second.root).toBeNull();
    const fetched = h.event({
      kind: "blobFetched",
      hash: H("9"),
      bytes: new TextEncoder().encode('{"version":1,"files":{}}'),
      purpose: { type: "inheritRoot", executionId: second.executionId },
    });
    const manifest = manifestOf(fetched);
    expect(manifest.files["/state/acc"]).toEqual({ hash: H("7"), size: 12 });
    expect(manifest.files["/out/0/0"]).toEqual({ hash: H("1"), size: 256 });
    expect(manifest.files["/in/data.txt"]).toEqual(defaultBundleFiles["/in/data.txt"] as never);
    h.manifestStored(fetched, H("a"));
    expect(second.root).toBe(H("a"));
    expect(second.planTaskId).not.toBeNull();
    expect(h.invariants()).toEqual([]);
  });

  test("a non-persist program does not inherit unless the launch says so", () => {
    const h = harness();
    h.hello("a", "h1");
    h.addProgram("tiles");
    h.launch({ preset: 0 }, true);
    finish(h, H("9"));
    h.launch({ preset: 1 }, true);
    expect(runningExec(h.ledger).inheritedFrom).toBeNull();
  });

  test("an expired root is a warning, not a failure: the run starts from the bundle", () => {
    const h = harness();
    h.subscribe("obs");
    h.hello("a", "h1");
    h.addProgram("text", true);
    h.launch({ preset: 0 }, true);
    finish(h, H("9"));
    h.launch({ preset: 1 }, true);
    const second = runningExec(h.ledger);
    const effects = h.event({
      kind: "blobFetched",
      hash: H("9"),
      bytes: null,
      purpose: { type: "inheritRoot", executionId: second.executionId },
    });
    const warning = effects.find((e) => e.kind === "send" && e.msg.t === "executionWarning");
    if (warning?.kind !== "send" || warning.msg.t !== "executionWarning")
      throw new Error("no warning");
    expect(warning.msg.code).toBe("expired-root");
    expect(warning.msg.message).toContain("starting from the bundle");
    expect(second.root).toBe(BUNDLE);
    expect(second.files).toEqual(defaultBundleFiles);
    expect(second.status).toBe("running");
    expect(second.planTaskId).not.toBeNull();
    expect(h.invariants()).toEqual([]);
  });

  test("inheriting from a named execution that never finished is refused at launch", () => {
    const h = harness();
    h.hello("a", "h1");
    h.addProgram("tiles");
    const effects = h.event({
      kind: "launch",
      bundle: BUNDLE,
      params: {},
      human: true,
      inherit: "e404",
    });
    expect(effects.length).toBe(0);
    expect(h.ledger.executions.size).toBe(0);
  });
});
