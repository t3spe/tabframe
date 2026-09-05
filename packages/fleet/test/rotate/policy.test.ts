import { describe, expect, test } from "bun:test";
import { EMPTY_POINTER, type Pointer } from "../../src/pointer.ts";
import {
  isScheduledEvent,
  RECENT_ROTATION_MS,
  skipIfIdle,
  skipIfRecent,
} from "../../src/rotate/policy.ts";
import type { MicrovmInfo, MicrovmState } from "../../src/types.ts";

const NOW = 1_700_000_000_000;

function pointer(partial: Partial<Pointer>): Pointer {
  return { ...EMPTY_POINTER, state: "on", microvmId: "mvm-1", generation: 3, ...partial };
}

function vm(state: MicrovmState): MicrovmInfo {
  return {
    microvmId: "mvm-1",
    state,
    endpoint: null,
    imageArn: null,
    imageVersion: null,
    startedAt: null,
    stateReason: null,
  };
}

describe("isScheduledEvent", () => {
  test("only an EventBridge event counts", () => {
    expect(isScheduledEvent({ source: "aws.events", "detail-type": "Scheduled Event" })).toBe(true);
    expect(isScheduledEvent({ reason: "operator" })).toBe(false);
    expect(isScheduledEvent(undefined)).toBe(false);
    expect(isScheduledEvent(null)).toBe(false);
    expect(isScheduledEvent("aws.events")).toBe(false);
  });
});

describe("skipIfRecent", () => {
  test("a pointer changed within the window stands the run down, with its age", () => {
    const skip = skipIfRecent(pointer({ updatedAt: new Date(NOW - 60_000).toISOString() }), NOW);
    expect(skip?.result).toEqual({ action: "skipped-recent" });
    expect(skip?.fields).toEqual({ ageMs: 60_000 });
  });

  test("an older change, or no timestamp, lets the run go on", () => {
    const old = new Date(NOW - RECENT_ROTATION_MS).toISOString();
    expect(skipIfRecent(pointer({ updatedAt: old }), NOW)).toBeNull();
    expect(skipIfRecent(pointer({ updatedAt: "" }), NOW)).toBeNull();
    expect(skipIfRecent(pointer({ updatedAt: "not a date" }), NOW)).toBeNull();
  });
});

describe("skipIfIdle", () => {
  test("a suspended control plane is left for a visitor to wake", () => {
    const skip = skipIfIdle(pointer({}), vm("SUSPENDED"));
    expect(skip?.result).toEqual({ action: "skipped-suspended" });
    expect(skip?.fields).toEqual({ microvmId: "mvm-1" });
  });

  test("one ended by its ceiling is left for a visitor to heal, unless a successor is pending", () => {
    expect(skipIfIdle(pointer({}), vm("TERMINATED"))?.result).toEqual({
      action: "skipped-terminated",
    });
    expect(skipIfIdle(pointer({}), vm("TERMINATING"))?.result).toEqual({
      action: "skipped-terminated",
    });
    const pending = { microvmId: "mvm-2", endpoint: null, generation: 4 };
    expect(skipIfIdle(pointer({ pending }), vm("TERMINATED"))).toBeNull();
  });

  test("a running, pending, or missing control plane is rotated or healed", () => {
    expect(skipIfIdle(pointer({}), vm("RUNNING"))).toBeNull();
    expect(skipIfIdle(pointer({}), vm("PENDING"))).toBeNull();
    expect(skipIfIdle(pointer({}), null)).toBeNull();
  });
});
