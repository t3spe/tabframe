import { describe, expect, test } from "bun:test";
import { Timeline } from "./clock.ts";
import { loadProgram } from "./program.ts";
import { runSim } from "./sim.ts";
import { FakeStore, sha256 } from "./store.ts";

// The subset keeps the outermost tiles, the cheapest ones: a frame costs well under a second of
// real compute the first time and nothing afterwards (the compute cache is per process).
const program = loadProgram();
const TILES = 32;

describe("churn simulation", () => {
  test("an honest cluster under churn completes frames whose tiles match the goldens", () => {
    for (const seed of [1, 2, 3]) {
      const r = runSim({ seed, tiles: TILES, program, liar: false });
      expect(r.violations).toEqual([]);
      expect(r.stats.framesDone).toBeGreaterThanOrEqual(1);
      expect(r.stats.mismatched).toBe(0);
      expect(r.stats.liesAccepted).toBe(0);
    }
  }, 120_000);

  test("a run is a pure function of its seed", () => {
    const a = runSim({ seed: 7, tiles: 16, program });
    const b = runSim({ seed: 7, tiles: 16, program });
    expect(a.trace).toBe(b.trace);
    expect(a.violations).toEqual(b.violations);
    expect(a.stats.events).toBe(b.stats.events);
    expect(a.virtualMs).toBe(b.virtualMs);
    const c = runSim({ seed: 8, tiles: 16, program });
    expect(c.trace).not.toBe(a.trace);
  }, 120_000);

  test("with redundancy on, a lying node's tiles are caught and recomputed", () => {
    let caught = 0;
    for (const seed of [4, 5, 6]) {
      const r = runSim({ seed, tiles: TILES, program, liar: true, redundancy: "always" });
      expect(r.violations).toEqual([]);
      expect(r.stats.framesDone).toBeGreaterThanOrEqual(1);
      if (r.stats.liesTold > 0) caught += r.stats.mismatched;
    }
    expect(caught).toBeGreaterThan(0);
  }, 120_000);

  test("without redundancy a liar's tile is painted, and the sim says so", () => {
    const r = runSim({ seed: 9, tiles: TILES, program, liar: true, redundancy: "never" });
    expect(r.violations).toEqual([]);
    expect(r.stats.liesTold).toBeGreaterThan(0);
  }, 120_000);

  test("the fleet keeps two cloud cores, replaces one that dies, sleeps, and wakes", () => {
    const r = runSim({ seed: 11, tiles: TILES, program, liar: false, drill: true });
    expect(r.violations).toEqual([]);
    // Two at boot, more as the chaos destroys them, and two again after waking.
    expect(r.stats.coresLaunched).toBeGreaterThanOrEqual(4);
    expect(r.stats.coreJoins).toBeGreaterThanOrEqual(2);
    // The sleep gave the cores back, and the visitor woke the machine.
    expect(r.stats.sleeps).toBe(1);
    expect(r.stats.wakes).toBe(1);
    expect(r.stats.coresTerminated).toBeGreaterThanOrEqual(2);
    // No record sat without a node for longer than a boot and a reconcile.
    expect(r.stats.coresAdriftMs).toBeLessThan(30_000);
  }, 120_000);

  test("cloud cores travel with the ledger: a snapshot round trip keeps them, unlinked", () => {
    const r = runSim({ seed: 12, tiles: 16, program, liar: false });
    expect(r.violations).toEqual([]);
    expect(r.stats.coresLaunched).toBeGreaterThan(0);
  }, 120_000);

  test("the long scenario shape runs", () => {
    const r = runSim({ seed: 10, tiles: 16, program, long: true, frames: 2 });
    expect(r.violations).toEqual([]);
    expect(r.scenario.long).toBe(true);
    expect(r.stats.framesDone).toBeGreaterThanOrEqual(2);
  }, 120_000);
});

describe("simulation pieces", () => {
  test("the timeline fires timers in time order, ties by creation, and honours cancels", () => {
    const t = new Timeline(0);
    const fired: string[] = [];
    t.at(10, () => fired.push("a"));
    const b = t.at(5, () => fired.push("b"));
    t.at(5, () => fired.push("c"));
    t.after(1, () => fired.push("d"));
    t.cancel(b);
    while (t.step()) {}
    expect(fired).toEqual(["d", "c", "a"]);
    expect(t.now).toBe(10);
    expect(t.fired).toBe(3);
  });

  test("the fake store hashes like the real one and reads ranges", () => {
    const s = new FakeStore();
    const bytes = new TextEncoder().encode("hello");
    const hash = s.put(bytes);
    expect(hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(sha256(bytes)).toBe(hash);
    expect(s.has(hash)).toBe(true);
    expect(s.read(hash, 1, 2)).toEqual(new Uint8Array([101, 108]));
    expect(s.read(hash, 10, 2)).toEqual(new Uint8Array(0));
    expect(s.read(hash, 0, Number.POSITIVE_INFINITY)).toEqual(bytes);
    expect(s.read("0".repeat(64), 0, 1)).toBeNull();
    expect(s.get("0".repeat(64))).toBeNull();
  });
});
