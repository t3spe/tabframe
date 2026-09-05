import { describe, expect, test } from "bun:test";
import { nextScale, niceCeil, SCALE_HOLD_MS } from "./chart.ts";

describe("the chart's scale", () => {
  test("niceCeil rounds up to 1, 2, or 5 times a power of ten", () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(1)).toBe(1);
    expect(niceCeil(1.5)).toBe(2);
    expect(niceCeil(2)).toBe(2);
    expect(niceCeil(3)).toBe(5);
    expect(niceCeil(7)).toBe(10);
    expect(niceCeil(10)).toBe(10);
    expect(niceCeil(11)).toBe(20);
    expect(niceCeil(230)).toBe(500);
  });
  test("the scale rises at once and comes down only after a minute below half of it", () => {
    let s = { scale: 1, scaleAt: 0 };
    s = nextScale(7, s.scale, s.scaleAt, 1_000);
    expect(s).toEqual({ scale: 10, scaleAt: 1_000 });
    // A quieter second does not move it yet.
    expect(nextScale(2, s.scale, s.scaleAt, 30_000)).toEqual(s);
    // Still above half: it stays, however long.
    expect(nextScale(6, s.scale, s.scaleAt, 500_000)).toEqual(s);
    // Below half for a minute: down to a round number above the new peak.
    expect(nextScale(2, s.scale, s.scaleAt, 1_000 + SCALE_HOLD_MS)).toEqual(s);
    expect(nextScale(2, s.scale, s.scaleAt, 1_001 + SCALE_HOLD_MS)).toEqual({
      scale: 2,
      scaleAt: 1_001 + SCALE_HOLD_MS,
    });
  });
});
