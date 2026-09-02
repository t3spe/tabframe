import { describe, expect, test } from "bun:test";
import { FakeMicrovmClient } from "@tabframe/fleet/testing/fake";
import { CORE_MAX_DURATION_SECONDS, corePayload, createCoreFleet } from "./cores.ts";

const config = {
  imageArn: "arn:aws:lambda:us-west-2:000000000000:microvm-image:tabframe",
  imageVersion: "4",
  coreRoleArn: "arn:aws:iam::000000000000:role/tabframe-core",
  region: "us-west-2",
  sessionUrl: "https://session.example/",
  storeBase: "https://cdn.example/blob",
  generation: 9,
  fleetSecret: "s3cret",
};

describe("the cloud-core fleet", () => {
  test("launches a core with no ingress, no idle policy, and a four-hour ceiling", async () => {
    const microvms = new FakeMicrovmClient();
    const fleet = createCoreFleet(config, microvms);
    const id = await fleet.launch();
    expect(id).toBe("mvm-1");
    const run = microvms.runs[0];
    if (!run) throw new Error("no run");
    expect(run.params.executionRoleArn).toBe(config.coreRoleArn);
    expect(run.params.ingressConnectors).toEqual([]);
    expect(run.params.egressConnectors).toEqual([
      "arn:aws:lambda:us-west-2:aws:network-connector:aws-network-connector:INTERNET_EGRESS",
    ]);
    expect(run.params.idlePolicy).toBeNull();
    expect(run.params.maximumDurationInSeconds).toBe(CORE_MAX_DURATION_SECONDS);
    expect(run.params.clientToken).toContain("tabframe-core-g9");
    const payload = JSON.parse(run.params.runHookPayload) as Record<string, unknown>;
    expect(payload).toEqual({
      role: "core",
      generation: 9,
      snapshotKey: null,
      sessionUrl: config.sessionUrl,
      storeBase: config.storeBase,
      fleetSecret: "s3cret",
    });
  });

  test("every launch gets its own client token, so two cores are two MicroVMs", async () => {
    const microvms = new FakeMicrovmClient();
    const fleet = createCoreFleet(config, microvms);
    await fleet.launch();
    await fleet.launch();
    const [a, b] = microvms.runs;
    expect(a?.params.clientToken).not.toBe(b?.params.clientToken);
    expect(microvms.runs).toHaveLength(2);
  });

  test("terminate passes through; gone reports the ones no longer serving", async () => {
    const microvms = new FakeMicrovmClient();
    microvms.add({ microvmId: "alive", state: "RUNNING" });
    microvms.add({ microvmId: "suspended", state: "SUSPENDED" });
    microvms.add({ microvmId: "dead", state: "TERMINATED" });
    const fleet = createCoreFleet(config, microvms);
    await fleet.terminate("alive");
    expect(microvms.terminated).toEqual(["alive"]);
    expect(await fleet.gone(["suspended", "dead", "never-existed"])).toEqual([
      "dead",
      "never-existed",
    ]);
  });

  test("the payload names the core role and carries no snapshot", () => {
    expect(JSON.parse(corePayload(config))).toMatchObject({ role: "core", snapshotKey: null });
  });
});
