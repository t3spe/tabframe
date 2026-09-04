import { describe, expect, test } from "bun:test";
import type { OpsConfig } from "../src/config.ts";
import { down, up } from "../src/ops.ts";
import {
  FakeInvoker,
  FakeLogger,
  FakeMicrovmClient,
  FakeRuleControl,
  FakeSleeper,
  pointerStoreWith,
} from "../src/testing/fake.ts";

const config: OpsConfig = {
  pointerParam: "/tabframe/pointer",
  rotateFunctionName: "tabframe-rotate",
  ruleName: "tabframe-rotate-hourly",
  imageArn: "arn:aws:lambda:us-west-2:000000000000:microvm-image:tabframe",
};

function deps(pointer: ReturnType<typeof pointerStoreWith>, microvms = new FakeMicrovmClient()) {
  return {
    pointer,
    microvms,
    invoker: new FakeInvoker(),
    rules: new FakeRuleControl(),
    sleep: new FakeSleeper(),
    log: new FakeLogger(),
    config,
  };
}

describe("up", () => {
  test("turns the pointer on, enables the schedule, and invokes rotate synchronously", async () => {
    const pointer = pointerStoreWith({ state: "off", generation: 5 });
    const d = deps(pointer);
    d.invoker.syncResult = { action: "launched" };
    const result = await up(d);
    expect(result).toEqual({ action: "launched" });
    const written = pointer.writes.at(-1);
    expect(written?.state).toBe("on");
    expect(written?.generation).toBe(5);
    expect(d.rules.events).toEqual([{ rule: "tabframe-rotate-hourly", enabled: true }]);
    expect(d.invoker.calls).toEqual([
      { functionName: "tabframe-rotate", payload: { reason: "up" }, mode: "sync" },
    ]);
  });
});

describe("down", () => {
  test("disables the schedule, writes off, and terminates every live MicroVM from our image", async () => {
    const microvms = new FakeMicrovmClient();
    microvms.add({ microvmId: "cp-1", state: "RUNNING", imageArn: config.imageArn });
    microvms.add({ microvmId: "core-1", state: "SUSPENDED", imageArn: config.imageArn });
    microvms.add({ microvmId: "old", state: "TERMINATED", imageArn: config.imageArn });
    microvms.add({
      microvmId: "other",
      state: "RUNNING",
      imageArn: "arn:aws:lambda:us-west-2:000000000000:microvm-image:unrelated",
    });
    const pointer = pointerStoreWith({
      state: "on",
      microvmId: "cp-1",
      endpoint: "cp-1.on.aws",
      generation: 2,
    });
    const d = deps(pointer, microvms);

    const result = await down(d);
    expect(result.terminated.sort()).toEqual(["core-1", "cp-1"]);
    expect(microvms.terminated.sort()).toEqual(["core-1", "cp-1"]);
    expect(d.rules.events).toEqual([{ rule: "tabframe-rotate-hourly", enabled: false }]);
    const written = pointer.writes.at(-1);
    expect(written).toMatchObject({ state: "off", microvmId: null, endpoint: null, generation: 2 });
    // Two passes (WP8.3): a rotation racing `down` may launch after the first list.
    expect(d.sleep.slept).toEqual([150, 150, 2_000]);
  });
});
