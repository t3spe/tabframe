import { describe, expect, test } from "bun:test";
import { ago, fmtBytes, fmtCountdown, fmtMs, fmtTime, fmtValue, short } from "./format.ts";

describe("formatting", () => {
  test("byte sizes are binary, one decimal, everywhere", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2048)).toBe("2.0 KiB");
    expect(fmtBytes(18746)).toBe("18.3 KiB");
    expect(fmtBytes(3 * 1024 * 1024)).toBe("3.0 MiB");
  });
  test("values, countdowns, durations, hashes, and ages", () => {
    expect(fmtValue(14529)).toBe("14,529");
    expect(fmtValue(0.12345)).toBe("0.123");
    expect(fmtCountdown(2_400)).toBe("2.4 s");
    expect(fmtCountdown(0)).toBe("0.0 s");
    expect(fmtMs(null)).toBe("—");
    expect(fmtMs(412)).toBe("412 ms");
    expect(short("a".repeat(64))).toBe(`${"a".repeat(12)}…`);
    expect(short("b".repeat(64), 8)).toBe(`${"b".repeat(8)}…`);
    expect(ago(1_000, 31_000)).toBe("30 s");
    expect(ago(1_000, 121_000)).toBe("2 min");
    expect(ago(5_000, 1_000)).toBe("0 s");
  });
  test("times are 24-hour with seconds", () => {
    expect(fmtTime(Date.UTC(2026, 0, 1, 13, 5, 9))).toMatch(/^\d\d:\d\d:\d\d$/);
  });
});
