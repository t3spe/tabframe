// The process side of the fleet policy (design §6.8): the core wants two cores while awake, the
// process launches them, and — the part the churn simulation found missing — it notices when a
// core's MicroVM is gone so the core can replace it.
import { afterAll, describe, expect, test } from "bun:test";
import { LocalStore, MemorySnapshots } from "@tabframe/store";
import type { CoreFleet } from "./cores.ts";
import { type ControlPlane, createControlPlane } from "./server.ts";
import { runHook, testConfig, until } from "./testing.ts";

const config = testConfig({ coreCheckMs: 100 });

/** A fleet that launches instantly and reports whichever MicroVMs the test has declared dead. */
class FakeFleet implements CoreFleet {
  launches = 0;
  terminated: string[] = [];
  dead = new Set<string>();
  async launch(): Promise<{ microvmId: string; token: string }> {
    this.launches += 1;
    return { microvmId: `microvm-fake-${this.launches}`, token: "t".repeat(32) };
  }
  async terminate(microvmId: string): Promise<void> {
    this.terminated.push(microvmId);
  }
  async gone(ids: string[]): Promise<string[]> {
    return ids.filter((id) => this.dead.has(id));
  }
}

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
    const res = await runHook(
      cp,
      { role: "control-plane", generation: 1, snapshotKey: null },
      "vm-cp",
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
