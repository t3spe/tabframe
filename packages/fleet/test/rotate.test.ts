import { beforeEach, describe, expect, test } from "bun:test";
import {
  CONTROL_PLANE_IDLE_POLICY,
  CONTROL_PLANE_MAX_DURATION_SECONDS,
  type RotateConfig,
} from "../src/config.ts";
import type { ControlPlaneClient, ControlPlaneTarget } from "../src/cp-client.ts";
import { type ControlPlanePayload, createRotateHandler, DRAIN_GRACE_MS } from "../src/rotate.ts";
import {
  FakeClock,
  FakeLogger,
  FakeMicrovmClient,
  FakeSecretReader,
  FakeSleeper,
  pointerStoreWith,
} from "../src/testing/fake.ts";

const config: RotateConfig = {
  pointerParam: "/tabframe/pointer",
  region: "us-west-2",
  imageArn: "arn:aws:lambda:us-west-2:000000000000:microvm-image:tabframe",
  imageVersion: "4",
  controlPlaneRoleArn: "arn:aws:iam::000000000000:role/tabframe-control-plane",
  sessionUrl: "https://abc.lambda-url.us-west-2.on.aws/",
  storeBase: "https://d123.cloudfront.net",
  fleetSecretArn: "arn:aws:secretsmanager:us-west-2:000000000000:secret:tabframe-fleet",
  snapshotBucket: null,
  readyTimeoutMs: 30_000,
  pollIntervalMs: 2000,
};

describe("rotate handler", () => {
  let microvms: FakeMicrovmClient;
  let clock: FakeClock;
  let sleep: FakeSleeper;
  let log: FakeLogger;
  const secrets = new FakeSecretReader({ [config.fleetSecretArn]: "s3cret" });

  beforeEach(() => {
    microvms = new FakeMicrovmClient();
    clock = new FakeClock();
    sleep = new FakeSleeper(clock);
    log = new FakeLogger();
  });

  function handler(
    pointer: ReturnType<typeof pointerStoreWith>,
    overrides: Partial<RotateConfig> = {},
  ) {
    return createRotateHandler({
      pointer,
      microvms,
      secrets,
      clock,
      sleep,
      log,
      config: { ...config, ...overrides },
    });
  }

  test("off: does nothing", async () => {
    const pointer = pointerStoreWith({ state: "off" });
    expect(await handler(pointer)()).toEqual({ action: "skipped-off" });
    expect(microvms.runs).toHaveLength(0);
    expect(pointer.writes).toHaveLength(0);
  });

  test("a running control plane is rotated, not left alone", async () => {
    microvms.add({ microvmId: "mvm-9", state: "RUNNING" });
    const pointer = pointerStoreWith({ state: "on", microvmId: "mvm-9", generation: 7 });
    const result = await handler(pointer)();
    expect(result).toMatchObject({ action: "rotated", from: "mvm-9", generation: 8 });
    expect(microvms.runs).toHaveLength(1);
    // Without a control-plane client there is no handover; the successor keeps its snapshot state.
    expect(result.action === "rotated" && result.handedOver).toBe(false);
    expect(microvms.terminated).toEqual(["mvm-9"]);
    expect(pointer.writes.at(-1)?.generation).toBe(8);
    expect(pointer.writes.at(-1)?.pending).toBeNull();
  });

  test("launches a control plane with the design's payload, connectors, policy, and role", async () => {
    microvms.add({ microvmId: "mvm-old", state: "TERMINATED" });
    const pointer = pointerStoreWith({ state: "on", microvmId: "mvm-old", generation: 1 });
    const result = await handler(pointer)();
    expect(result.action).toBe("launched");
    if (result.action !== "launched") return;
    expect(result.generation).toBe(2);

    const run = microvms.runs[0];
    if (!run) throw new Error("no run recorded");
    expect(run.params.imageArn).toBe(config.imageArn);
    expect(run.params.imageVersion).toBe("4");
    expect(run.params.executionRoleArn).toBe(config.controlPlaneRoleArn);
    expect(run.params.ingressConnectors).toEqual([
      "arn:aws:lambda:us-west-2:aws:network-connector:aws-network-connector:ALL_INGRESS",
    ]);
    expect(run.params.egressConnectors).toEqual([
      "arn:aws:lambda:us-west-2:aws:network-connector:aws-network-connector:INTERNET_EGRESS",
    ]);
    expect(run.params.idlePolicy).toEqual(CONTROL_PLANE_IDLE_POLICY);
    expect(run.params.maximumDurationInSeconds).toBe(CONTROL_PLANE_MAX_DURATION_SECONDS);
    expect(run.params.clientToken).toMatch(/^tabframe-cp-g2-\d+$/); // per generation and hour

    const payload = JSON.parse(run.params.runHookPayload) as ControlPlanePayload;
    expect(payload).toEqual({
      role: "control-plane",
      generation: 2,
      snapshotKey: null,
      sessionUrl: config.sessionUrl,
      storeBase: config.storeBase,
      fleetSecret: "s3cret",
    });

    const written = pointer.writes.at(-1);
    expect(written?.state).toBe("on");
    expect(written?.microvmId).toBe(result.microvmId);
    expect(written?.generation).toBe(2);
    expect(written?.endpoint).toBe(`${result.microvmId}.lambda-microvm.us-west-2.on.aws`);
    expect(written?.imageVersion).toBe("4");
    expect(written?.updatedAt).toBe(new Date(clock.now()).toISOString());
  });

  test("first launch on an empty pointer is generation 1", async () => {
    const pointer = pointerStoreWith({ state: "on" });
    const result = await handler(pointer)();
    expect(result).toMatchObject({ action: "launched", generation: 1 });
  });

  test("polls until RUNNING, sleeping the poll interval each time", async () => {
    microvms.plan.push({ pendingPolls: 3, endsIn: "RUNNING" });
    const result = await handler(pointerStoreWith({ state: "on" }))();
    expect(result.action).toBe("launched");
    expect(sleep.slept).toEqual([2000, 2000, 2000]);
  });

  test("backs off on throttling and then succeeds", async () => {
    microvms.plan.push({ throttle: true }, { throttle: true });
    const result = await handler(pointerStoreWith({ state: "on" }))();
    expect(result.action).toBe("launched");
    expect(sleep.slept.slice(0, 2)).toEqual([1000, 2000]);
    expect(microvms.runs).toHaveLength(1);
    expect(log.lines.filter((l) => l.level === "warn")).toHaveLength(2);
  });

  test("gives up after the backoff schedule is exhausted", async () => {
    for (let i = 0; i < 5; i++) microvms.plan.push({ throttle: true });
    const pointer = pointerStoreWith({ state: "on" });
    const result = await handler(pointer)();
    expect(result).toEqual({ action: "failed", reason: "Rate exceeded" });
    expect(sleep.slept).toEqual([1000, 2000, 4000, 8000]);
    expect(pointer.writes).toHaveLength(0);
  });

  test("fails when the new control plane never reaches RUNNING before the deadline, and terminates it", async () => {
    microvms.plan.push({ pendingPolls: 1000, endsIn: "RUNNING" });
    const pointer = pointerStoreWith({ state: "on" });
    const result = await handler(pointer, { readyTimeoutMs: 5000 })();
    expect(result.action).toBe("failed");
    // The launch is recorded before the wait and forgotten when it fails.
    expect(pointer.writes.at(-1)?.pending ?? null).toBeNull();
    // The successor that never came up is not left running for hours, blocking every later try.
    expect(microvms.terminated).toEqual([microvms.runs[0]?.microvmId ?? "?"]);
    // And the client token carries the hour, so the next try is not resolved to the same VM.
    expect(microvms.runs[0]?.params.clientToken).toMatch(/^tabframe-cp-g\d+-\d+$/);
  });

  test("a suspended control plane is left alone by the scheduled rule and rotated by an operator", async () => {
    microvms.add({ microvmId: "mvm-asleep", state: "SUSPENDED" });
    const pointer = pointerStoreWith({
      state: "on",
      microvmId: "mvm-asleep",
      generation: 7,
      updatedAt: new Date(clock.now() - 2 * 60 * 60_000).toISOString(),
    });
    const scheduled = await handler(pointer)({
      source: "aws.events",
      "detail-type": "Scheduled Event",
    });
    expect(scheduled).toEqual({ action: "skipped-suspended" });
    expect(microvms.runs).toHaveLength(0);
    const manual = await handler(pointer)();
    expect(manual.action).toBe("rotated");
    expect(microvms.runs).toHaveLength(1);
  });

  test("fails when the new control plane terminates during boot", async () => {
    microvms.plan.push({ pendingPolls: 0, endsIn: "TERMINATED" });
    const pointer = pointerStoreWith({ state: "on" });
    const result = await handler(pointer)();
    expect(result.action).toBe("failed");
    // The launch is recorded before the wait and forgotten when it fails.
    expect(pointer.writes.at(-1)?.pending ?? null).toBeNull();
  });
});

// ---- the full rotation, with a fake control plane on the other end --------------------------------

class FakeControlPlane implements ControlPlaneClient {
  readonly calls: string[] = [];
  ledger = '{"version":1,"meta":{"generation":7}}';
  failHandover = false;
  failAdopt = false;
  failDrain = false;
  clients = 3;
  adopted: string | null = null;
  drainedNext: number | null = null;

  async handover(target: ControlPlaneTarget) {
    this.calls.push(`handover:${target.microvmId}`);
    if (this.failHandover) throw new Error("handover unreachable");
    return { generation: 7, ledger: this.ledger };
  }
  async adopt(target: ControlPlaneTarget, ledger: string) {
    this.calls.push(`adopt:${target.microvmId}`);
    if (this.failAdopt) throw new Error("adopt refused");
    this.adopted = ledger;
    return { generation: 8 };
  }
  async drain(target: ControlPlaneTarget, next: number) {
    this.calls.push(`drain:${target.microvmId}`);
    if (this.failDrain) throw new Error("drain unreachable");
    this.drainedNext = next;
    return { drained: this.clients };
  }
  async health() {
    return { role: "control-plane", generation: 7 };
  }
}

describe("rotation", () => {
  let microvms: FakeMicrovmClient;
  let clock: FakeClock;
  let sleep: FakeSleeper;
  let log: FakeLogger;
  let cp: FakeControlPlane;
  const secrets = new FakeSecretReader({ [config.fleetSecretArn]: "s3cret" });

  beforeEach(() => {
    microvms = new FakeMicrovmClient();
    clock = new FakeClock();
    sleep = new FakeSleeper(clock);
    log = new FakeLogger();
    cp = new FakeControlPlane();
  });

  const rotate = (
    pointer: ReturnType<typeof pointerStoreWith>,
    latestSnapshotKey: string | null = "g7/2026-09-02.json.gz",
  ) =>
    createRotateHandler({
      pointer,
      microvms,
      secrets,
      clock,
      sleep,
      log,
      config,
      controlPlane: () => cp,
      snapshots: { latestKey: async () => latestSnapshotKey },
    });

  test("the five steps happen in order, and the successor is told where the snapshot is", async () => {
    microvms.add({ microvmId: "mvm-old", state: "RUNNING" });
    const pointer = pointerStoreWith({
      state: "on",
      microvmId: "mvm-old",
      endpoint: "old.on.aws",
      generation: 7,
    });
    const result = await rotate(pointer)();
    expect(result).toMatchObject({
      action: "rotated",
      from: "mvm-old",
      generation: 8,
      handedOver: true,
      drained: 3,
    });
    const to = result.action === "rotated" ? result.to : "";
    expect(cp.calls).toEqual([`handover:mvm-old`, `adopt:${to}`, `drain:mvm-old`]);
    expect(cp.adopted).toBe(cp.ledger);
    expect(cp.drainedNext).toBe(8);
    const payload = JSON.parse(
      microvms.runs[0]?.params.runHookPayload ?? "{}",
    ) as ControlPlanePayload;
    expect(payload.snapshotKey).toBe("g7/2026-09-02.json.gz");
    expect(payload.generation).toBe(8);
    // The pointer records the successor before the handover and clears it after the flip.
    expect(pointer.writes[0]?.pending).toMatchObject({ microvmId: to, generation: 8 });
    expect(pointer.writes.at(-1)).toMatchObject({ microvmId: to, generation: 8, pending: null });
    // The old one is drained, given a grace period, then terminated.
    expect(sleep.slept.at(-1)).toBe(DRAIN_GRACE_MS);
    expect(microvms.terminated).toEqual(["mvm-old"]);
  });

  test("a handover that fails still rotates: the successor booted from the snapshot", async () => {
    cp.failHandover = true;
    microvms.add({ microvmId: "mvm-old", state: "RUNNING" });
    const pointer = pointerStoreWith({ state: "on", microvmId: "mvm-old", generation: 7 });
    const result = await rotate(pointer)();
    expect(result).toMatchObject({ action: "rotated", handedOver: false });
    expect(cp.adopted).toBeNull();
    expect(microvms.terminated).toEqual(["mvm-old"]);
    expect(log.lines.some((l) => l.level === "warn")).toBe(true);
  });

  test("an adopt that fails is the same story, and a drain that fails still terminates", async () => {
    cp.failAdopt = true;
    cp.failDrain = true;
    microvms.add({ microvmId: "mvm-old", state: "RUNNING" });
    const pointer = pointerStoreWith({ state: "on", microvmId: "mvm-old", generation: 7 });
    const result = await rotate(pointer)();
    expect(result).toMatchObject({ action: "rotated", handedOver: false, drained: 0 });
    expect(microvms.terminated).toEqual(["mvm-old"]);
    expect(pointer.writes.at(-1)?.generation).toBe(8);
  });

  test("a successor that never boots leaves the pointer alone", async () => {
    microvms.add({ microvmId: "mvm-old", state: "RUNNING" });
    microvms.plan.push({ pendingPolls: 0, endsIn: "TERMINATED" });
    const pointer = pointerStoreWith({ state: "on", microvmId: "mvm-old", generation: 7 });
    const result = await rotate(pointer)();
    expect(result.action).toBe("failed");
    // The launch is recorded before the wait and forgotten when it fails.
    expect(pointer.writes.at(-1)?.pending ?? null).toBeNull();
    expect(pointer.writes.at(-1)?.microvmId).toBe("mvm-old");
    // The successor that never booted is cleaned up; the old control plane is not touched.
    expect(microvms.terminated).toEqual(["mvm-1"]);
    expect(cp.calls).toEqual([]);
  });

  test("a retire a dead rotation left behind is finished first", async () => {
    microvms.add({ microvmId: "mvm-old", state: "RUNNING" });
    microvms.add({ microvmId: "mvm-cur", state: "RUNNING" });
    const pointer = pointerStoreWith({
      state: "on",
      microvmId: "mvm-cur",
      endpoint: "cur.on.aws",
      generation: 8,
      retiring: { microvmId: "mvm-old", endpoint: "old.on.aws" },
    });
    const result = await rotate(pointer)();
    expect(result.action).toBe("rotated");
    // The predecessor is drained and terminated before anything else happens, and the pointer forgets it.
    expect(cp.calls[0]).toBe("drain:mvm-old");
    expect(microvms.terminated[0]).toBe("mvm-old");
    expect(pointer.writes[0]).toMatchObject({ microvmId: "mvm-cur", retiring: null });
    // No later write brings the cleared record back from the stale read (the rotation's own promote
    // names mvm-cur as the next predecessor, which is right), and the run ends with none.
    for (const w of pointer.writes) expect(w.retiring?.microvmId ?? null).not.toBe("mvm-old");
    expect(pointer.writes.at(-1)?.retiring ?? null).toBeNull();
  });

  test("a run that resolves to a terminated replay is retried with a fresh token", async () => {
    microvms.add({ microvmId: "mvm-old", state: "RUNNING" });
    microvms.plan.push({ replayTerminated: true });
    const pointer = pointerStoreWith({ state: "on", microvmId: "mvm-old", generation: 7 });
    const result = await rotate(pointer)();
    expect(result.action).toBe("rotated");
    expect(microvms.runs).toHaveLength(2);
    expect(microvms.runs[0]?.params.clientToken).toMatch(/^tabframe-cp-g8-\d+$/);
    expect(microvms.runs[1]?.params.clientToken).toMatch(/^tabframe-cp-g8-\d+-r1$/);
    expect(result.action === "rotated" ? result.to : "").toBe(microvms.runs[1]?.microvmId ?? "?");
  });

  test("a rotation that died after launching is finished by the next run", async () => {
    const successor = microvms.add({ microvmId: "mvm-new", state: "RUNNING" });
    microvms.add({ microvmId: "mvm-old", state: "RUNNING" });
    const pointer = pointerStoreWith({
      state: "on",
      microvmId: "mvm-old",
      endpoint: "old.on.aws",
      generation: 7,
      pending: { microvmId: "mvm-new", endpoint: successor.endpoint, generation: 8 },
    });
    // The old control plane still serves, so the pending successor — which never adopted the live
    // ledger — is terminated and a fresh rotation follows from the live one.
    const result = await rotate(pointer)();
    expect(result).toMatchObject({ action: "rotated", from: "mvm-old", generation: 8 });
    expect(microvms.runs).toHaveLength(1);
    expect(microvms.terminated[0]).toBe("mvm-new");
    expect(microvms.terminated).toContain("mvm-old");
    expect(pointer.writes.at(-1)?.pending).toBeNull();
    expect(pointer.writes.at(-1)?.microvmId).not.toBe("mvm-new");
    expect(cp.calls.some((c) => c.startsWith("handover:mvm-old"))).toBe(true);
  });

  test("a pending successor that died is forgotten, and the run carries on", async () => {
    microvms.add({ microvmId: "mvm-old", state: "RUNNING" });
    const pointer = pointerStoreWith({
      state: "on",
      microvmId: "mvm-old",
      generation: 7,
      pending: { microvmId: "mvm-ghost", endpoint: null, generation: 8 },
    });
    const result = await rotate(pointer)();
    expect(result).toMatchObject({ action: "rotated", generation: 8 });
    expect(pointer.writes[0]?.pending).toBeNull();
    expect(microvms.terminated).toEqual(["mvm-old"]);
  });

  test("a pending successor the pointer already passed is terminated", async () => {
    microvms.add({ microvmId: "mvm-stale", state: "RUNNING" });
    microvms.add({ microvmId: "mvm-live", state: "RUNNING" });
    const pointer = pointerStoreWith({
      state: "on",
      microvmId: "mvm-live",
      generation: 9,
      pending: { microvmId: "mvm-stale", endpoint: null, generation: 8 },
    });
    const result = await rotate(pointer)();
    expect(microvms.terminated).toContain("mvm-stale");
    expect(result).toMatchObject({ action: "rotated", from: "mvm-live", generation: 10 });
  });

  test("nothing serving: a heal launches one and never calls the old one", async () => {
    microvms.add({ microvmId: "mvm-dead", state: "TERMINATED" });
    const pointer = pointerStoreWith({ state: "on", microvmId: "mvm-dead", generation: 4 });
    const result = await rotate(pointer)();
    expect(result).toMatchObject({ action: "launched", generation: 5 });
    expect(cp.calls).toEqual([]);
    expect(microvms.terminated).toEqual([]);
  });

  test("off is still off, whatever is pending", async () => {
    const pointer = pointerStoreWith({
      state: "off",
      microvmId: "mvm-old",
      pending: { microvmId: "mvm-new", endpoint: null, generation: 8 },
    });
    expect(await rotate(pointer)()).toEqual({ action: "skipped-off" });
    expect(microvms.runs).toHaveLength(0);
    expect(pointer.writes).toHaveLength(0);
  });

  // ---- what an interrupted or racing rotation leaves behind --------------------------------------

  test("a pending successor is terminated while the current control plane still serves; the rotation starts afresh", async () => {
    microvms.add({ microvmId: "mvm-9", state: "RUNNING" });
    microvms.add({ microvmId: "mvm-stale", state: "RUNNING" });
    const pointer = pointerStoreWith({
      state: "on",
      microvmId: "mvm-9",
      generation: 7,
      pending: { microvmId: "mvm-stale", endpoint: "stale.example", generation: 8 },
    });
    const result = await rotate(pointer)();
    // Not promoted: it never adopted the live ledger. Gone, and a fresh successor took over.
    expect(result.action).toBe("rotated");
    expect(microvms.terminated).toContain("mvm-stale");
    expect(microvms.terminated).toContain("mvm-9");
    expect(microvms.runs).toHaveLength(1);
    expect(pointer.writes.at(-1)?.pending).toBeNull();
    expect(pointer.writes.at(-1)?.microvmId).not.toBe("mvm-stale");
  });

  test("a pending successor is still promoted when nothing else serves", async () => {
    microvms.add({ microvmId: "mvm-9", state: "TERMINATED" });
    microvms.add({ microvmId: "mvm-next", state: "RUNNING" });
    const pointer = pointerStoreWith({
      state: "on",
      microvmId: "mvm-9",
      generation: 7,
      pending: { microvmId: "mvm-next", endpoint: "next.example", generation: 8 },
    });
    const result = await rotate(pointer)();
    expect(result).toMatchObject({ action: "repaired", microvmId: "mvm-next", generation: 8 });
  });

  test("a scheduled rotation minutes after the last pointer change is skipped; an operator's is not", async () => {
    microvms.add({ microvmId: "mvm-9", state: "RUNNING" });
    const pointer = pointerStoreWith({
      state: "on",
      microvmId: "mvm-9",
      generation: 7,
      updatedAt: new Date(clock.now() - 60_000).toISOString(),
    });
    expect(
      await rotate(pointer)({ source: "aws.events", "detail-type": "Scheduled Event" }),
    ).toEqual({
      action: "skipped-recent",
    });
    expect(microvms.runs).toHaveLength(0);
    const manual = await rotate(pointer)();
    expect(manual.action).toBe("rotated");
  });
});
