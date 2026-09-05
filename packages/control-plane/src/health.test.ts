import { describe, expect, test } from "bun:test";
import { createLedger } from "@tabframe/core";
import { LocalStore } from "@tabframe/store";
import { buildStamp, diagReport, type HealthView, healthReport, probeDiag } from "./health.ts";

const snapshots = { writes: 1, lastKey: "g3/x", lastAt: 1, lastBytes: 2, lastError: null };
const neutral: HealthView = {
  role: "neutral",
  phase: "neutral",
  mode: "image",
  generation: 1,
  build: null,
  imageVersion: null,
  authoritative: false,
  ledger: null,
  snapshots,
  startedAt: 100,
};

describe("healthReport", () => {
  test("carries the keys the runbook documents, with the ledger's counts and the cores' tails", () => {
    const ledger = createLedger(3, { storeBase: "http://s/blob" }, 1_000);
    ledger.cores.set("microvm-0123456789abcdef", {
      microvmId: "microvm-0123456789abcdef",
      launchedAt: 500,
      nodeId: null,
      token: "t",
    } as never);
    const report = healthReport(
      {
        ...neutral,
        role: "control-plane",
        phase: "active",
        generation: 3,
        build: { sha: "abc" },
        imageVersion: "7",
        authoritative: true,
        ledger,
      },
      1_100,
    );
    expect(Object.keys(report).sort()).toEqual(
      [
        "ok",
        "role",
        "phase",
        "mode",
        "generation",
        "protocol",
        "build",
        "imageVersion",
        "authoritative",
        "awake",
        "sleepReason",
        "nodes",
        "nodesByKind",
        "cores",
        "cloudCores",
        "observers",
        "programs",
        "running",
        "queue",
        "executions",
        "tasks",
        "loopBackoffMs",
        "snapshots",
        "uptimeMs",
      ].sort(),
    );
    expect(report.cores).toEqual([{ microvmId: "…89abcdef", ageMs: 600, linked: false }]);
    expect(report.uptimeMs).toBe(1_000);
    expect(report.build).toEqual({ sha: "abc" });
    expect(report.imageVersion).toBe("7");
    expect(report.nodes).toBe(0);
    expect(report.programs).toEqual([]);
  });

  test("a neutral process reports without a ledger", () => {
    const report = healthReport(neutral, 150);
    expect(report.role).toBe("neutral");
    expect(report.awake).toBeNull();
    expect(report.cores).toEqual([]);
    expect(report.cloudCores).toBe(false);
    expect(report.uptimeMs).toBe(50);
  });
});

describe("buildStamp", () => {
  test("the whole stamp wins over the bare sha; bad JSON falls back; nothing is null", () => {
    expect(buildStamp({ TABFRAME_BUILD_JSON: '{"sha":"a"}', TABFRAME_BUILD: "a" })).toEqual({
      sha: "a",
    });
    expect(buildStamp({ TABFRAME_BUILD: "a" })).toBe("a");
    expect(buildStamp({ TABFRAME_BUILD_JSON: "{", TABFRAME_BUILD: "a" })).toBe("a");
    expect(buildStamp({})).toBeNull();
  });
});

describe("diag", () => {
  test("the store probe puts and gets through the driver; the report carries the environment", async () => {
    const probes = await probeDiag(new LocalStore("http://s/blob"), 4);
    expect(probes.store).toStartWith("ok (put and get");
    const report = diagReport(
      {
        ...neutral,
        storeBase: "http://s/blob",
        storeDriver: "local",
        localBlobs: 1,
        programsDir: null,
        sandboxWorker: null,
      },
      { dns: "skipped", store: probes.store },
      200,
    );
    expect(report.storeDriver).toBe("local");
    expect(report.env).toEqual({ programsDir: null, sandboxWorker: null, cloudCores: false });
    expect(report.uptimeMs).toBe(100);
    expect(report.node).toBe(process.version);
  });
});
