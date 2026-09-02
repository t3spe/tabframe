import { beforeEach, describe, expect, test } from "bun:test";
import {
  CONTROL_PLANE_IDLE_POLICY,
  CONTROL_PLANE_MAX_DURATION_SECONDS,
  type RotateConfig,
} from "../src/config.ts";
import { type ControlPlanePayload, createRotateHandler } from "../src/rotate.ts";
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
  readyTimeoutMs: 30_000,
  pollIntervalMs: 2000,
};

describe("rotate handler v0", () => {
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

  test("a running control plane is left alone (idempotent)", async () => {
    microvms.add({ microvmId: "mvm-9", state: "RUNNING" });
    const pointer = pointerStoreWith({ state: "on", microvmId: "mvm-9", generation: 7 });
    expect(await handler(pointer)()).toEqual({
      action: "noop-running",
      microvmId: "mvm-9",
      generation: 7,
    });
    expect(microvms.runs).toHaveLength(0);
    expect(pointer.writes).toHaveLength(0);
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
    expect(run.params.clientToken).toBe("tabframe-cp-g2");

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
    microvms.pendingPolls = 3;
    const result = await handler(pointerStoreWith({ state: "on" }))();
    expect(result.action).toBe("launched");
    expect(sleep.slept).toEqual([2000, 2000, 2000]);
  });

  test("backs off on throttling and then succeeds", async () => {
    microvms.throttleRuns = 2;
    const result = await handler(pointerStoreWith({ state: "on" }))();
    expect(result.action).toBe("launched");
    expect(sleep.slept.slice(0, 2)).toEqual([1000, 2000]);
    expect(microvms.runs).toHaveLength(1);
    expect(log.lines.filter((l) => l.level === "warn")).toHaveLength(2);
  });

  test("gives up after the backoff schedule is exhausted", async () => {
    microvms.throttleRuns = 5;
    const pointer = pointerStoreWith({ state: "on" });
    const result = await handler(pointer)();
    expect(result).toEqual({ action: "failed", reason: "Rate exceeded" });
    expect(sleep.slept).toEqual([1000, 2000, 4000, 8000]);
    expect(pointer.writes).toHaveLength(0);
  });

  test("fails when the new control plane never reaches RUNNING before the deadline", async () => {
    microvms.pendingPolls = 1000;
    const pointer = pointerStoreWith({ state: "on" });
    const result = await handler(pointer, { readyTimeoutMs: 5000 })();
    expect(result.action).toBe("failed");
    expect(pointer.writes).toHaveLength(0);
  });

  test("fails when the new control plane terminates during boot", async () => {
    microvms.terminateAfterRun = true;
    const pointer = pointerStoreWith({ state: "on" });
    const result = await handler(pointer)();
    expect(result.action).toBe("failed");
    expect(pointer.writes).toHaveLength(0);
  });
});
