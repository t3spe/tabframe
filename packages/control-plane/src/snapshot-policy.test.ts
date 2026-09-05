import { describe, expect, test } from "bun:test";
import { mayWriteSnapshot, type SnapshotReason } from "./snapshot-policy.ts";

const reasons: SnapshotReason[] = ["timer", "suspend", "terminate", "handover", "drain", "test"];

describe("mayWriteSnapshot", () => {
  test("nothing but a control plane writes", () => {
    for (const reason of reasons) {
      expect(
        mayWriteSnapshot({ role: "neutral", phase: "neutral", authoritative: true }, reason),
      ).toBe(false);
      expect(
        mayWriteSnapshot({ role: "core", phase: "neutral", authoritative: true }, reason),
      ).toBe(false);
    }
  });

  test("the timer needs an active, named control plane; a standby and a predecessor stay silent", () => {
    expect(
      mayWriteSnapshot({ role: "control-plane", phase: "active", authoritative: true }, "timer"),
    ).toBe(true);
    expect(
      mayWriteSnapshot({ role: "control-plane", phase: "active", authoritative: false }, "timer"),
    ).toBe(false);
    expect(
      mayWriteSnapshot(
        { role: "control-plane", phase: "handing-over", authoritative: true },
        "timer",
      ),
    ).toBe(false);
    expect(
      mayWriteSnapshot({ role: "control-plane", phase: "drained", authoritative: true }, "timer"),
    ).toBe(false);
  });

  test("the hooks write while active whatever the pointer says; not after a handover or a drain", () => {
    for (const reason of ["suspend", "terminate", "drain"] as const) {
      expect(
        mayWriteSnapshot({ role: "control-plane", phase: "active", authoritative: false }, reason),
      ).toBe(true);
      expect(
        mayWriteSnapshot(
          { role: "control-plane", phase: "handing-over", authoritative: true },
          reason,
        ),
      ).toBe(false);
      expect(
        mayWriteSnapshot({ role: "control-plane", phase: "drained", authoritative: true }, reason),
      ).toBe(false);
    }
  });

  test("a handover writes the ledger it hands over, and the test seam writes whatever the phase", () => {
    for (const phase of ["active", "handing-over", "drained"] as const) {
      expect(
        mayWriteSnapshot({ role: "control-plane", phase, authoritative: false }, "handover"),
      ).toBe(true);
      expect(mayWriteSnapshot({ role: "control-plane", phase, authoritative: false }, "test")).toBe(
        true,
      );
    }
  });
});
