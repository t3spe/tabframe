import { beforeEach, describe, expect, test } from "bun:test";
import type { RotateConfig } from "../../src/config.ts";
import type { ControlPlaneClient, ControlPlaneTarget } from "../../src/cp-client.ts";
import { PENDING_IN_PROGRESS_MS } from "../../src/rotate/policy.ts";
import { repair } from "../../src/rotate/repair.ts";
import {
  FakeClock,
  FakeLogger,
  FakeMicrovmClient,
  FakeSecretReader,
  FakeSleeper,
  pointerStoreWith,
} from "../../src/testing/fake.ts";

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

describe("repair", () => {
  let microvms: FakeMicrovmClient;
  let clock: FakeClock;
  let sleep: FakeSleeper;
  let log: FakeLogger;
  const drains: string[] = [];
  const cp: ControlPlaneClient = {
    handover: async () => {
      throw new Error("a repair never hands over");
    },
    adopt: async () => ({ generation: 0 }),
    drain: async (target: ControlPlaneTarget) => {
      drains.push(target.microvmId);
      return { drained: 2 };
    },
    health: async () => ({ role: "control-plane", generation: 0 }),
  };

  beforeEach(() => {
    microvms = new FakeMicrovmClient();
    clock = new FakeClock();
    sleep = new FakeSleeper(clock);
    log = new FakeLogger();
    drains.length = 0;
  });

  const deps = (pointer: ReturnType<typeof pointerStoreWith>) => ({
    pointer,
    microvms,
    secrets: new FakeSecretReader(),
    clock,
    sleep,
    log,
    config,
    controlPlane: () => cp,
  });

  test("no pending record: nothing to settle", async () => {
    const pointer = pointerStoreWith({ state: "on", microvmId: "mvm-1", generation: 7 });
    expect(await repair(deps(pointer), await pointer.read(), "s")).toBeNull();
    expect(pointer.writes).toHaveLength(0);
  });

  test("a pending record younger than a run's timeout belongs to a rotation still running", async () => {
    const pointer = pointerStoreWith({
      state: "on",
      microvmId: "mvm-1",
      generation: 7,
      pending: {
        microvmId: "mvm-2",
        endpoint: null,
        generation: 8,
        at: clock.now() - PENDING_IN_PROGRESS_MS + 1,
      },
    });
    expect(await repair(deps(pointer), await pointer.read(), "s")).toEqual({
      action: "in-progress",
      microvmId: "mvm-2",
      generation: 8,
    });
    expect(pointer.writes).toHaveLength(0);
    expect(microvms.terminated).toEqual([]);
  });

  test("a pending successor that is gone is forgotten", async () => {
    microvms.add({ microvmId: "mvm-1", state: "RUNNING" });
    const pointer = pointerStoreWith({
      state: "on",
      microvmId: "mvm-1",
      generation: 7,
      pending: { microvmId: "mvm-ghost", endpoint: null, generation: 8 },
    });
    expect(await repair(deps(pointer), await pointer.read(), "s")).toBeNull();
    expect(pointer.writes).toEqual([{ ...(await pointer.read()), pending: null }]);
    expect(microvms.terminated).toEqual([]);
  });

  test("a pending successor the pointer already passed is terminated and forgotten", async () => {
    microvms.add({ microvmId: "mvm-live", state: "RUNNING" });
    microvms.add({ microvmId: "mvm-stale", state: "RUNNING" });
    const pointer = pointerStoreWith({
      state: "on",
      microvmId: "mvm-live",
      generation: 9,
      pending: { microvmId: "mvm-stale", endpoint: null, generation: 8 },
    });
    expect(await repair(deps(pointer), await pointer.read(), "s")).toBeNull();
    expect(microvms.terminated).toEqual(["mvm-stale"]);
    expect(pointer.writes.at(-1)?.pending).toBeNull();
  });

  test("a stale successor beside a serving control plane is terminated; the rotation starts afresh", async () => {
    microvms.add({ microvmId: "mvm-9", state: "RUNNING" });
    microvms.add({ microvmId: "mvm-stale", state: "SUSPENDED" });
    const pointer = pointerStoreWith({
      state: "on",
      microvmId: "mvm-9",
      generation: 7,
      pending: { microvmId: "mvm-stale", endpoint: "stale.example", generation: 8 },
    });
    expect(await repair(deps(pointer), await pointer.read(), "s")).toBeNull();
    expect(microvms.terminated).toEqual(["mvm-stale"]);
    expect(pointer.writes.at(-1)).toMatchObject({
      microvmId: "mvm-9",
      generation: 7,
      pending: null,
    });
  });

  test("a serving successor is promoted when nothing else serves, and the predecessor is retired", async () => {
    microvms.add({ microvmId: "mvm-old", state: "TERMINATED" });
    const next = microvms.add({ microvmId: "mvm-next", state: "RUNNING" });
    const pointer = pointerStoreWith({
      state: "on",
      microvmId: "mvm-old",
      endpoint: "old.on.aws",
      generation: 7,
      pending: { microvmId: "mvm-next", endpoint: next.endpoint, generation: 8 },
    });
    expect(await repair(deps(pointer), await pointer.read(), "s")).toEqual({
      action: "repaired",
      microvmId: "mvm-next",
      generation: 8,
      endpoint: next.endpoint,
    });
    expect(pointer.writes.at(-1)).toMatchObject({
      state: "on",
      microvmId: "mvm-next",
      generation: 8,
      pending: null,
      retiring: null,
    });
    expect(drains).toEqual(["mvm-old"]);
    expect(microvms.terminated).toEqual(["mvm-old"]);
  });

  test("a `down` that landed since the pointer was read wins over the promotion", async () => {
    microvms.add({ microvmId: "mvm-old", state: "TERMINATED" });
    microvms.add({ microvmId: "mvm-next", state: "RUNNING" });
    const pointer = pointerStoreWith({
      state: "on",
      microvmId: "mvm-old",
      generation: 7,
      pending: { microvmId: "mvm-next", endpoint: null, generation: 8 },
    });
    const p = await pointer.read();
    await pointer.write({ ...p, state: "off" });
    expect(await repair(deps(pointer), p, "s")).toEqual({ action: "skipped-off" });
    expect(microvms.terminated).toEqual(["mvm-next"]);
    expect((await pointer.read()).state).toBe("off");
  });
});
