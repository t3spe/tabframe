import { describe, expect, test } from "bun:test";
import {
  byteLength,
  canonicalStringify,
  controlPlaneToObserver,
  encode,
  LIMITS,
  type StageSpec,
} from "@tabframe/protocol";
import { executionTasks } from "./execution.ts";
import { BUNDLE, H, harness } from "./harness.ts";
import { taskView } from "./ledger.ts";

/** Snapshot pages (design §8.3): what a fresh subscriber is sent, and that every page fits a frame. */

describe("snapshot pages", () => {
  test("carry the cluster on page 0 and the execution's tasks", () => {
    const h = harness();
    h.stage(1, 300);
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

  test("stay under the message cap for a full frame of done tiles", () => {
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

  test("page 0 fits one frame under heavy programs: sixty-four with four kilobytes of defaults each still subscribe, defaults stripped", () => {
    const h = harness();
    h.hello("a", "h1");
    const heavy = { blob: "x".repeat(3_900) };
    for (let i = 0; i < 64; i++) {
      const c = (i + 10).toString(36).padStart(2, "0");
      h.event({
        kind: "programAdded",
        bundle: H(c[0] ?? "a").slice(0, 62) + c,
        module: H("d"),
        manifest: { name: `p${i}`, view: "tiles", persist: false, defaultParams: heavy },
        files: {},
      });
    }
    const effects = h.subscribe("obs");
    const pages = effects.filter((e) => e.kind === "send" && e.msg.t === "snapshot");
    expect(pages.length).toBeGreaterThan(0);
    for (const e of pages) {
      if (e.kind !== "send") continue;
      // encode() throws over the cap; nothing here does.
      expect(new TextEncoder().encode(encode(e.msg)).length).toBeLessThanOrEqual(
        LIMITS.maxMessageBytes,
      );
    }
    const first = pages[0];
    if (first?.kind === "send" && first.msg.t === "snapshot" && "programs" in first.msg) {
      const programs = first.msg.programs as Array<{ defaultParams: Record<string, unknown> }>;
      expect(programs.length).toBe(64);
      expect(programs.every((p) => Object.keys(p.defaultParams).length === 0)).toBe(true);
    } else {
      throw new Error("page 0 carries the cluster");
    }
    // A light ledger keeps its defaults.
    const light = harness();
    light.hello("a", "h1");
    light.event({
      kind: "programAdded",
      bundle: H("e"),
      module: H("d"),
      manifest: { name: "light", view: "tiles", persist: false, defaultParams: { preset: 1 } },
      files: {},
    });
    const page0 = light.subscribe("obs").find((e) => e.kind === "send" && e.msg.t === "snapshot");
    if (page0?.kind === "send" && page0.msg.t === "snapshot" && "programs" in page0.msg) {
      const programs = page0.msg.programs as Array<{ defaultParams: Record<string, unknown> }>;
      expect(programs.some((p) => p.defaultParams.preset === 1)).toBe(true);
    }
  });
});

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
        source: null,
      },
    ]);
  });
});

/** Nothing running: a late observer still sees the execution that ended last. */
describe("the snapshot after a launch ends", () => {
  test("shows the last ended execution with its tasks instead of idle", () => {
    const h = harness();
    h.hello("a", "h1");
    h.addProgram("tiles");
    h.launch({ preset: 0 }, true);
    h.tick();
    const exec = [...h.ledger.executions.values()][0];
    if (!exec) throw new Error("nothing launched");
    const plan = h.planAssign(exec.executionId);
    h.planSpec(h.result(plan.connId, plan.taskId, plan.attempt, H("e")), {
      kind: "done",
      next: null,
    });
    expect(exec.status).toBe("done");
    expect(h.ledger.running).toBeNull();
    const snap = h.subscribe("late").find((e) => e.kind === "send" && e.msg.t === "snapshot");
    if (snap?.kind !== "send" || snap.msg.t !== "snapshot") throw new Error("no snapshot");
    expect(snap.msg.execution?.executionId).toBe(exec.executionId);
    expect(snap.msg.execution?.status).toBe("done");
    expect(snap.msg.tasks.length).toBeGreaterThan(0);
  });
});

describe("a trapped task in the snapshot", () => {
  test("a failed plan task has no output in the view, and the snapshot after a trap still decodes", () => {
    const h = harness();
    h.hello("a", "h1");
    h.addProgram("tiles");
    h.launch({ preset: 1 }, true); // e1, a person's; its plan task goes to the node on the next fill
    h.tick();
    const plan = h.planAssign("e1");
    h.resultError(plan.connId, plan.taskId, plan.attempt, "abort: this planner refuses to plan");
    expect(h.ledger.executions.get("e1")?.status).toBe("failed");
    const snap = h.subscribe("late").find((e) => e.kind === "send" && e.msg.t === "snapshot");
    if (snap?.kind !== "send" || snap.msg.t !== "snapshot") throw new Error("no snapshot");
    // A trapped task carrying output "" made the snapshot undecodable, so nobody arriving after a
    // trap could subscribe until the execution was pruned.
    const failed = snap.msg.tasks.find((t) => t.taskId === plan.taskId);
    expect(failed?.status).toBe("failed");
    expect(failed?.output).toBeNull();
    expect(controlPlaneToObserver.safeParse(JSON.parse(JSON.stringify(snap.msg))).success).toBe(
      true,
    );
  });
});
