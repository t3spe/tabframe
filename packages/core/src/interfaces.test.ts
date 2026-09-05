import { describe, expect, test } from "bun:test";
import { seededRng, systemClock } from "./interfaces.ts";

describe("seededRng", () => {
  test("is deterministic for a seed and different across seeds", () => {
    const a = seededRng(42);
    const b = seededRng(42);
    const c = seededRng(43);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    expect(Array.from({ length: 5 }, () => c())).not.toEqual(xs);
  });
  test("stays in [0, 1) and looks uniform enough", () => {
    const r = seededRng(7);
    let sum = 0;
    for (let i = 0; i < 10_000; i++) {
      const x = r();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      sum += x;
    }
    expect(sum / 10_000).toBeGreaterThan(0.45);
    expect(sum / 10_000).toBeLessThan(0.55);
  });
});

test("systemClock reads the wall clock", () => {
  const before = Date.now();
  const now = systemClock.now();
  expect(now).toBeGreaterThanOrEqual(before);
  expect(now).toBeLessThanOrEqual(Date.now());
});
