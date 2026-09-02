// The process side of the fleet policy (design §6.8): the core wants two cores while awake, the
// process launches them, and — the part the churn simulation found missing — it notices when a
// core's MicroVM is gone so the core can replace it.
import { afterAll, describe, expect, test } from "bun:test";
import { LocalStore, MemorySnapshots } from "@tabframe/store";
import type { Config } from "./config.ts";
import type { CoreFleet } from "./cores.ts";
import { type ControlPlane, createControlPlane } from "./server.ts";

const config: Config = {
  mode: "image",
  publicPort: 0,
  privatePort: 0,
  host: "127.0.0.1",
  generation: 1,
  storeBase: null,
  webDir: null,
  blobBucket: null,
  localOff: false,
  localNeutral: false,
  tickMs: 50,
  programsDir: null,
  defaultProgram: "mandelbrot",
  snapshotBucket: null,
  snapshotEveryMs: 60_000,
  coreCheckMs: 100,
  imageArn: null,
  imageVersion: null,
  coreRoleArn: null,
  region: "us-west-2",
  sessionUrl: null,
};

/** A fleet that launches instantly and reports whichever MicroVMs the test has declared dead. */
class FakeFleet implements CoreFleet {
  launches = 0;
  terminated: string[] = [];
  dead = new Set<string>();
  async launch(): Promise<string> {
    this.launches += 1;
    return `microvm-fake-${this.launches}`;
  }
  async terminate(microvmId: string): Promise<void> {
    this.terminated.push(microvmId);
  }
  async gone(ids: string[]): Promise<string[]> {
    return ids.filter((id) => this.dead.has(id));
  }
}

const until = async (pred: () => boolean, ms: number, what: string) => {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
};

describe("the process keeps the fleet the core asks for", () => {
  const planes: ControlPlane[] = [];
  afterAll(async () => {
    for (const cp of planes) await cp.close();
  });

  test("two cores are launched a second apart, and a dead one is noticed and replaced", async () => {
    const fleet = new FakeFleet();
    const cp = await createControlPlane(config, undefined, {
      store: new LocalStore("http://s/blob"),
      snapshots: new MemorySnapshots(),
      programs: [],
      cores: fleet,
    });
    planes.push(cp);
    const res = await fetch(
      `http://127.0.0.1:${cp.privateAddress.port}/aws/lambda-microvms/runtime/v1/run`,
      {
        method: "POST",
        body: JSON.stringify({
          microvmId: "vm-cp",
          runHookPayload: JSON.stringify({
            role: "control-plane",
            generation: 1,
            snapshotKey: null,
          }),
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(cp.ledger?.config.cloudCores).toBe(true);

    // The policy launches one core per second: two within a few seconds.
    await until(() => (cp.ledger?.cores.size ?? 0) === 2, 5_000, "two cores in the ledger");
    expect(fleet.launches).toBe(2);
    const [first] = [...(cp.ledger?.cores.keys() ?? [])];
    expect(first).toBeDefined();

    // Its MicroVM dies. The reaper notices, the record goes, and the policy launches a third.
    fleet.dead.add(first as string);
    await until(
      () => !cp.ledger?.cores.has(first as string),
      3_000,
      "the dead core to be forgotten",
    );
    await until(() => fleet.launches === 3, 5_000, "a replacement to be launched");
    expect(cp.ledger?.cores.size).toBe(2);
    expect(cp.ledger?.cores.has(first as string)).toBe(false);
  }, 20_000);
});
