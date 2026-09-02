import { describe, expect, test } from "bun:test";
import { connectionCopy, fmtCountdown, machineCopy, ROTATING_DETAIL } from "./banners.ts";

describe("banner copy", () => {
  test("every connection state says what is happening and what the visitor can do", () => {
    for (const state of ["connecting", "starting", "off", "outdated"] as const) {
      const c = connectionCopy(state);
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.body.length).toBeGreaterThan(20);
      expect(c.hint.length).toBeGreaterThan(0);
    }
    expect(connectionCopy("off").body).toContain("mise run up");
    expect(connectionCopy("off").hint).toContain("?demo=1");
    expect(connectionCopy("starting").title).toContain("Waking");
    expect(connectionCopy("connecting", ROTATING_DETAIL).title).toContain("rotating");
    expect(connectionCopy("connecting", ROTATING_DETAIL).body).toContain("new generation");
    expect(connectionCopy("connecting", "retrying").body).toBe("retrying");
    expect(connectionCopy("outdated", "protocol 3").body).toContain("protocol 3");
    expect(connectionCopy("outdated").hint).toContain("Reloading");
  });

  test("the machine banners name the generation, the countdown, and the reason", () => {
    const r = machineCopy({ kind: "rotating", next: 8, msLeft: 2_400 });
    expect(r.title).toBe("Control plane rotating to generation 8.");
    expect(r.body).toContain("fresh MicroVM");
    expect(fmtCountdown(2_400)).toBe("2.4 s");
    expect(fmtCountdown(0)).toBe("0.0 s");
    const s = machineCopy({ kind: "sleeping", reason: "ten minutes with nobody watching" });
    expect(s.title).toContain("going to sleep");
    expect(s.body).toContain("ten minutes with nobody watching");
    expect(s.hint).toContain("wakes it");
    const a = machineCopy({ kind: "asleep", reason: null });
    expect(a.title).toContain("asleep");
    expect(a.body).toContain("Your visit wakes it");
    expect(machineCopy({ kind: "asleep", reason: "x" }).body).toContain("after x");
  });
});
