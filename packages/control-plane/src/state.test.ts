import { describe, expect, test } from "bun:test";
import { createLedger, type Effect } from "@tabframe/core";
import { createProcessState } from "./state.ts";

describe("ProcessState", () => {
  test("is neutral with the configured generation until an identity is assumed, once", () => {
    const state = createProcessState({ clock: { now: () => 0 }, generation: 4, sessionUrl: "u" });
    expect(state.role).toBe("neutral");
    expect(state.generation).toBe(4);
    expect(state.sessionUrl).toBe("u");
    expect(state.phase()).toBe("neutral");
    state.assume({
      role: "control-plane",
      generation: 7,
      microvmId: "vm",
      fleetSecret: "s",
      sessionUrl: null,
    });
    expect(state.role).toBe("control-plane");
    expect(state.generation).toBe(7);
    expect(state.sessionUrl).toBeNull();
    expect(state.fleetSecret).toBe("s");
    expect(state.microvmId).toBe("vm");
    expect(() =>
      state.assume({
        role: "core",
        generation: 8,
        microvmId: null,
        fleetSecret: null,
        sessionUrl: null,
      }),
    ).toThrow(/already control-plane/);
  });

  test("the phase follows the ledger, and dispatch does nothing without one or after close", () => {
    const executed: Effect[][] = [];
    const state = createProcessState({
      clock: { now: () => 1_000 },
      generation: 1,
      sessionUrl: null,
    });
    state.bind((effects) => executed.push(effects));
    state.dispatch({ kind: "tick" });
    expect(executed).toEqual([]);
    state.assume({
      role: "control-plane",
      generation: 1,
      microvmId: null,
      fleetSecret: null,
      sessionUrl: null,
    });
    expect(state.phase()).toBe("active");
    state.own(createLedger(1, { storeBase: "http://s/blob" }, 1_000));
    state.dispatch({ kind: "connected", connId: "c1", role: "node" });
    expect(executed.length).toBe(1);
    expect(state.ledger?.conns.size).toBe(1);
    state.close();
    state.dispatch({ kind: "disconnected", connId: "c1" });
    expect(executed.length).toBe(1);
    expect(state.ledger?.conns.size).toBe(1);
  });
});
