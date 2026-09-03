import { describe, expect, test } from "bun:test";
import { decode, encode } from "./codec.ts";
import { fsManifest, programManifest } from "./fs.ts";
import { LIMITS, PROTOCOL_VERSION } from "./limits.ts";
import { assign, controlPlaneToNode, nodeToControlPlane, presigned, result } from "./node.ts";
import { controlPlaneToObserver, observerToControlPlane } from "./observer.ts";
import { taskView } from "./task.ts";

const base = { v: PROTOCOL_VERSION, gen: 2 } as const;
const H = "a".repeat(64);
const limits = {
  maxOutputBytes: 1,
  maxWriteBytes: 1,
  maxWriteFiles: 1,
  maxLogBytes: 1,
  memoryPagesMax: 1,
};

describe("v1 node messages", () => {
  test("assign and result round-trip; result needs exactly one of output or error", () => {
    const a = {
      t: "assign",
      ...base,
      taskId: "t1",
      attempt: 1,
      executionId: "e1",
      program: H,
      kind: "run",
      stage: 0,
      index: 3,
      count: 640,
      input: "AAEC",
      fsRoot: null,
      deadlineMs: 4000,
      limits,
    };
    expect(decode(controlPlaneToNode, encode(a)).ok).toBe(true);
    const ok = {
      t: "result",
      ...base,
      taskId: "t1",
      attempt: 1,
      output: H,
      outputSize: 3,
      writes: [{ path: "/out/x", hash: H, size: 3 }],
      log: { text: "hi" },
      computeMs: 12,
    };
    const d = decode(nodeToControlPlane, encode(ok));
    expect(d.ok && d.msg.t === "result" && d.msg.output).toBe(H);
    const err = {
      t: "result",
      ...base,
      taskId: "t1",
      attempt: 1,
      error: "trap: unreachable",
      computeMs: 1,
    };
    const e = decode(result, encode(err));
    expect(e.ok && e.msg.error).toBe("trap: unreachable");
    expect(e.ok && e.msg.writes).toEqual([]);
    expect(
      decode(result, encode({ t: "result", ...base, taskId: "t1", attempt: 1, computeMs: 1 })).ok,
    ).toBe(false);
    expect(
      decode(
        result,
        encode({
          t: "result",
          ...base,
          taskId: "t1",
          attempt: 1,
          output: H,
          error: "x",
          computeMs: 1,
        }),
      ).ok,
    ).toBe(false);
  });
  test("presign, presigned, cancel, command", () => {
    expect(
      decode(nodeToControlPlane, encode({ t: "presign", ...base, items: [{ hash: H, size: 10 }] }))
        .ok,
    ).toBe(true);
    expect(
      decode(
        presigned,
        encode({ t: "presigned", ...base, urls: [{ hash: H, url: null, headers: {} }] }),
      ).ok,
    ).toBe(true);
    expect(decode(controlPlaneToNode, encode({ t: "cancel", ...base, taskId: "t1" })).ok).toBe(
      true,
    );
    expect(decode(controlPlaneToNode, encode({ t: "command", ...base, op: "freeze" })).ok).toBe(
      true,
    );
    expect(decode(controlPlaneToNode, encode({ t: "command", ...base, op: "explode" })).ok).toBe(
      false,
    );
  });
  test("paths in writes must be absolute and simple", () => {
    for (const bad of ["out/x", "/out/../x", "/", "/a//b", "/sp ace"]) {
      expect(
        decode(
          result,
          encode({
            t: "result",
            ...base,
            taskId: "t",
            attempt: 1,
            output: H,
            writes: [{ path: bad, hash: H, size: 1 }],
            computeMs: 1,
          }),
        ).ok,
      ).toBe(false);
    }
  });
  test("inline input cap", () => {
    const a = {
      t: "assign",
      ...base,
      taskId: "t1",
      attempt: 1,
      executionId: "e1",
      program: H,
      kind: "plan",
      stage: 0,
      index: 0,
      count: 1,
      input: "A".repeat(Math.ceil((LIMITS.maxInlineInputBytes * 4) / 3) + 8),
      fsRoot: H,
      deadlineMs: 1,
      limits,
    };
    expect(decode(assign, encode(a)).ok).toBe(false);
  });
});

describe("v1 observer messages", () => {
  test("controls and launch", () => {
    for (const t of [
      "killHalf",
      "freezeHalf",
      "throttleHalf",
      "resumeAll",
      "restart",
      "skip",
      "stop",
      "start",
    ]) {
      expect(decode(observerToControlPlane, encode({ t, ...base })).ok).toBe(true);
    }
    expect(
      decode(observerToControlPlane, encode({ t: "killExecution", ...base, executionId: "e1" })).ok,
    ).toBe(true);
    const l = decode(
      observerToControlPlane,
      encode({ t: "launch", ...base, bundle: H, params: { preset: 1 } }),
    );
    expect(l.ok && l.msg.t === "launch" && l.msg.inherit).toBeNull();
    expect(
      decode(
        observerToControlPlane,
        encode({ t: "launch", ...base, bundle: H, params: {}, inherit: "latest" }),
      ).ok,
    ).toBe(true);
    expect(
      decode(observerToControlPlane, encode({ t: "setRedundancy", ...base, on: true })).ok,
    ).toBe(true);
    expect(
      decode(observerToControlPlane, encode({ t: "runFollowUp", ...base, executionId: "e1" })).ok,
    ).toBe(true);
  });
  test("snapshot page 0 carries the cluster, later pages only tasks", () => {
    const task = {
      taskId: "t1",
      executionId: "e1",
      stage: 0,
      index: 0,
      kind: "run",
      status: "pending",
      holders: [],
      attempts: 0,
      output: null,
      place: null,
      contested: false,
    };
    const page0 = {
      t: "snapshot",
      ...base,
      seq: 1,
      page: 0,
      pages: 2,
      nodes: [],
      execution: null,
      queue: [],
      machine: { awake: true, reason: null, redundancy: false, nextRotationAt: null, uptimeMs: 1 },
      tasks: [task],
      at: 1,
    };
    expect(decode(controlPlaneToObserver, encode(page0)).ok).toBe(true);
    const page1 = { t: "snapshot", ...base, seq: 1, page: 1, pages: 2, tasks: [task], at: 1 };
    expect(decode(controlPlaneToObserver, encode(page1)).ok).toBe(true);
  });
  test("events", () => {
    const ev = { ...base, seq: 5 };
    const samples = [
      {
        t: "taskDone",
        ...ev,
        taskId: "t1",
        nodeId: "n1",
        output: H,
        place: { x: 0, y: 0, w: 64, h: 64 },
        computeMs: 5,
      },
      { t: "taskAssigned", ...ev, taskId: "t1", nodeId: "n1", attempt: 1 },
      { t: "taskReassigned", ...ev, taskId: "t1", fromNode: "n1" },
      { t: "taskSpeculated", ...ev, taskId: "t1", nodeId: "n2" },
      { t: "taskVerified", ...ev, taskId: "t1", nodeId: "n2" },
      { t: "taskMismatch", ...ev, taskId: "t1", nodeId: "n2" },
      { t: "taskFailed", ...ev, taskId: "t1", reason: "trap" },
      {
        t: "stageStarted",
        ...ev,
        executionId: "e1",
        stage: 0,
        name: "render",
        taskCount: 640,
        canvas: { w: 2048, h: 1280 },
      },
      { t: "stageDone", ...ev, executionId: "e1", stage: 0, root: H },
      { t: "executionDone", ...ev, executionId: "e1", root: H, followUp: { preset: 2 } },
      { t: "executionFailed", ...ev, executionId: "e1", reason: "write conflict at /x" },
      { t: "controlApplied", ...ev, op: "killHalf", nodeIds: ["n1", "n2"] },
      { t: "programAdded", ...ev, program: H, name: "mandelbrot" },
      { t: "programRetired", ...ev, program: H, name: "mandelbrot" },
      { t: "controlApplied", ...ev, op: "stop", nodeIds: [] },
      { t: "controlApplied", ...ev, op: "start", nodeIds: [] },
      { t: "controlPlaneRotating", ...ev, next: 3, reconnectAfterMs: 2500 },
      { t: "machineSleeping", ...ev, reason: "no observers for 10 minutes" },
      { t: "budget", ...ev, executionId: "e1", computeMsUsed: 10, computeMsCap: 100 },
      { t: "executionWarning", ...ev, executionId: "e1", code: "expired-root", message: "gone" },
    ];
    for (const s of samples) expect(decode(controlPlaneToObserver, encode(s)).ok).toBe(true);
  });
  test("a task's log rides along optionally: inline text, a blob hash, null, or absent", () => {
    const ev = { ...base, seq: 5 };
    const done = {
      t: "taskDone",
      ...ev,
      taskId: "t1",
      nodeId: "n1",
      output: H,
      place: null,
      computeMs: 5,
    };
    for (const log of [undefined, null, { text: "ran 64 rows" }, { hash: H }]) {
      const msg = log === undefined ? done : { ...done, log };
      expect(decode(controlPlaneToObserver, encode(msg)).ok).toBe(true);
    }
    const tooLong = { ...done, log: { text: "x".repeat(LIMITS.maxInlineLogBytes + 1) } };
    expect(decode(controlPlaneToObserver, encode(tooLong)).ok).toBe(false);
    const view = {
      taskId: "t1",
      executionId: "e1",
      stage: 0,
      index: 0,
      kind: "run",
      status: "done",
      holders: [],
      attempts: 1,
      output: H,
      place: null,
      contested: false,
      log: { hash: H },
    };
    expect(taskView.safeParse(view).success).toBe(true);
    expect(taskView.safeParse({ ...view, log: { text: 5 } }).success).toBe(false);
  });
});

describe("manifests", () => {
  test("program manifest applies defaults; filesystem manifest validates paths", () => {
    const m = programManifest.parse({ name: "mandelbrot", view: "tiles" });
    expect(m.persist).toBe(false);
    expect(m.defaultParams).toEqual({});
    expect(programManifest.safeParse({ name: "", view: "tiles" }).success).toBe(false);
    expect(
      fsManifest.safeParse({ version: 1, files: { "/in/corpus.txt": { hash: H, size: 1 } } })
        .success,
    ).toBe(true);
    expect(
      fsManifest.safeParse({ version: 1, files: { "in/corpus.txt": { hash: H, size: 1 } } })
        .success,
    ).toBe(false);
  });
});
