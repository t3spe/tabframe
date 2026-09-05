import { beforeEach, describe, expect, test } from "bun:test";
import {
  CONTROL_PLANE_IDLE_POLICY,
  CONTROL_PLANE_MAX_DURATION_SECONDS,
  type RotateConfig,
} from "../../src/config.ts";
import {
  type ControlPlanePayload,
  launchControlPlane,
  RUN_BACKOFF_MS,
  runWithBackoff,
  waitUntilRunning,
} from "../../src/rotate/launch.ts";
import { FakeClock, FakeLogger, FakeMicrovmClient, FakeSleeper } from "../../src/testing/fake.ts";
import type { MicrovmInfo, RunMicrovmParams } from "../../src/types.ts";

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

/** The fake with two failure modes the plan queue does not model: a failing poll and a hard run error. */
class FlakyMicrovms extends FakeMicrovmClient {
  failingGets = 0;
  nextRunError: Error | null = null;
  override async get(microvmId: string): Promise<MicrovmInfo | null> {
    if (this.failingGets > 0) {
      this.failingGets--;
      throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
    }
    return super.get(microvmId);
  }
  override async run(params: RunMicrovmParams): Promise<MicrovmInfo> {
    if (this.nextRunError) {
      const error = this.nextRunError;
      this.nextRunError = null;
      throw error;
    }
    return super.run(params);
  }
}

let microvms: FlakyMicrovms;
let clock: FakeClock;
let sleep: FakeSleeper;
let log: FakeLogger;

beforeEach(() => {
  microvms = new FlakyMicrovms();
  clock = new FakeClock();
  sleep = new FakeSleeper(clock);
  log = new FakeLogger();
});

const deps = (latestSnapshotKey: string | null = null) => ({
  microvms,
  clock,
  sleep,
  log,
  config,
  latestSnapshotKey: async () => latestSnapshotKey,
});

describe("launchControlPlane", () => {
  test("runs the image with the design's payload, connectors, policy, role, and a per-hour token", async () => {
    const vm = await launchControlPlane(deps("g7/latest.json.gz"), {
      generation: 8,
      secret: "s3cret",
      pin: null,
    });
    expect(vm?.state).toBe("RUNNING");
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
    expect(run.params.clientToken).toBe(`tabframe-cp-g8-${Math.floor(clock.now() / 3_600_000)}`);
    expect(JSON.parse(run.params.runHookPayload) as ControlPlanePayload).toEqual({
      role: "control-plane",
      generation: 8,
      snapshotKey: "g7/latest.json.gz",
      sessionUrl: config.sessionUrl,
      storeBase: config.storeBase,
      fleetSecret: "s3cret",
    });
  });

  test("the operator's pin wins over the configured image version", async () => {
    await launchControlPlane(deps(), { generation: 2, secret: "s", pin: "2" });
    expect(microvms.runs[0]?.params.imageVersion).toBe("2");
  });

  test("onLaunched runs as soon as the MicroVM exists, before the wait for RUNNING", async () => {
    microvms.plan.push({ pendingPolls: 2, endsIn: "RUNNING" });
    const seen: string[] = [];
    const vm = await launchControlPlane(deps(), {
      generation: 1,
      secret: "s",
      pin: null,
      onLaunched: async (launched) => {
        seen.push(launched.state);
      },
    });
    expect(seen).toEqual(["PENDING"]);
    expect(vm?.state).toBe("RUNNING");
    expect(sleep.slept).toEqual([2000, 2000]);
  });

  test("a token that replays a terminated MicroVM is retried with a numbered suffix, three times at most", async () => {
    microvms.plan.push({ replayTerminated: true });
    const vm = await launchControlPlane(deps(), { generation: 8, secret: "s", pin: null });
    expect(vm?.microvmId).toBe(microvms.runs[1]?.microvmId);
    expect(microvms.runs[1]?.params.clientToken).toMatch(/^tabframe-cp-g8-\d+-r1$/);

    microvms.plan.push(
      { replayTerminated: true },
      { replayTerminated: true },
      { replayTerminated: true },
    );
    expect(await launchControlPlane(deps(), { generation: 9, secret: "s", pin: null })).toBeNull();
    expect(microvms.runs).toHaveLength(5);
    expect(microvms.terminated).toEqual([]);
  });

  test("a successor that terminates during boot is reported as null and terminated for good measure", async () => {
    microvms.plan.push({ pendingPolls: 0, endsIn: "TERMINATED" });
    expect(await launchControlPlane(deps(), { generation: 1, secret: "s", pin: null })).toBeNull();
    expect(microvms.terminated).toEqual(["mvm-1"]);
  });

  test("a boot slower than the ready timeout is given up on and terminated", async () => {
    microvms.plan.push({ pendingPolls: 1000, endsIn: "RUNNING" });
    const vm = await launchControlPlane(
      { ...deps(), config: { ...config, readyTimeoutMs: 5000 } },
      { generation: 1, secret: "s", pin: null },
    );
    expect(vm).toBeNull();
    expect(sleep.slept).toEqual([2000, 2000, 2000]);
    expect(microvms.terminated).toEqual(["mvm-1"]);
  });
});

describe("runWithBackoff", () => {
  const params: RunMicrovmParams = {
    imageArn: config.imageArn,
    imageVersion: null,
    executionRoleArn: config.controlPlaneRoleArn,
    runHookPayload: "{}",
    ingressConnectors: [],
    egressConnectors: [],
    idlePolicy: null,
    maximumDurationInSeconds: 60,
    clientToken: null,
  };

  test("waits the schedule out while throttled, then succeeds", async () => {
    microvms.plan.push({ throttle: true }, { throttle: true });
    const vm = await runWithBackoff(deps(), params);
    expect(vm.microvmId).toBe("mvm-1");
    expect(sleep.slept).toEqual([1000, 2000]);
    expect(log.lines.filter((l) => l.level === "warn")).toHaveLength(2);
  });

  test("gives up once the schedule is exhausted", async () => {
    for (let i = 0; i <= RUN_BACKOFF_MS.length; i++) microvms.plan.push({ throttle: true });
    await expect(runWithBackoff(deps(), params)).rejects.toThrow("Rate exceeded");
    expect(sleep.slept).toEqual(RUN_BACKOFF_MS);
  });

  test("an error that is not throttling is not retried", async () => {
    microvms.nextRunError = Object.assign(new Error("denied"), { name: "AccessDeniedException" });
    await expect(runWithBackoff(deps(), params)).rejects.toThrow("denied");
    expect(sleep.slept).toEqual([]);
  });
});

describe("waitUntilRunning", () => {
  test("a failed poll is repeated, not taken for a dead MicroVM", async () => {
    microvms.add({ microvmId: "mvm-x", state: "RUNNING" });
    microvms.failingGets = 1;
    const vm = await waitUntilRunning(deps(), "mvm-x");
    expect(vm?.state).toBe("RUNNING");
    expect(sleep.slept).toEqual([2000]);
    expect(log.lines.filter((l) => l.level === "warn")).toHaveLength(1);
  });

  test("a MicroVM that is gone or terminated ends the wait at once", async () => {
    expect(await waitUntilRunning(deps(), "nope")).toBeNull();
    microvms.add({ microvmId: "dead", state: "TERMINATED" });
    expect(await waitUntilRunning(deps(), "dead")).toBeNull();
    expect(sleep.slept).toEqual([]);
  });
});
