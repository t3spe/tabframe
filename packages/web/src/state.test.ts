import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "@tabframe/protocol";
import { applyMessage, emptyState, hostCount } from "./state.ts";

const env = { v: PROTOCOL_VERSION, gen: 2 } as const;
const node = (id: string, hostId = "h1") => ({
  nodeId: id,
  hostId,
  kind: "tab" as const,
  health: "fast" as const,
  visible: true,
  tasksDone: 0,
  lastTaskMs: null,
  inFlight: 0,
  joinedAt: 1,
});

describe("cluster state", () => {
  test("snapshot pages accumulate and complete", () => {
    let s = emptyState();
    s = applyMessage(s, {
      t: "snapshot",
      ...env,
      seq: 10,
      page: 0,
      pages: 2,
      nodes: [node("n1")],
      at: 5,
    });
    expect(s.pagesPending).toBe(1);
    expect(s.generation).toBe(2);
    s = applyMessage(s, {
      t: "snapshot",
      ...env,
      seq: 10,
      page: 1,
      pages: 2,
      nodes: [node("n2", "h2")],
      at: 5,
    });
    expect(s.pagesPending).toBe(0);
    expect([...s.nodes.keys()]).toEqual(["n1", "n2"]);
    expect(hostCount(s)).toBe(2);
    expect(s.seq).toBe(10);
  });
  test("events in sequence apply; a skipped sequence number flags a gap", () => {
    let s = applyMessage(emptyState(), {
      t: "snapshot",
      ...env,
      seq: 3,
      page: 0,
      pages: 1,
      nodes: [],
      at: 0,
    });
    s = applyMessage(s, { t: "nodeJoined", ...env, seq: 4, node: node("n1") });
    expect(s.nodes.has("n1")).toBe(true);
    expect(s.gap).toBe(false);
    s = applyMessage(s, { t: "nodeHealth", ...env, seq: 5, nodeId: "n1", health: "throttled" });
    expect(s.nodes.get("n1")?.health).toBe("throttled");
    s = applyMessage(s, { t: "nodeLeft", ...env, seq: 7, nodeId: "n1", reason: "closed" });
    expect(s.nodes.has("n1")).toBe(false);
    expect(s.gap).toBe(true);
    expect(s.seq).toBe(7);
  });
  test("a pong ahead of the last seen sequence also flags a gap; errors are ignored", () => {
    let s = applyMessage(emptyState(), {
      t: "snapshot",
      ...env,
      seq: 3,
      page: 0,
      pages: 1,
      nodes: [],
      at: 0,
    });
    s = applyMessage(s, { t: "pong", ...env, seq: 3 });
    expect(s.gap).toBe(false);
    s = applyMessage(s, { t: "pong", ...env, seq: 9 });
    expect(s.gap).toBe(true);
    const before = s;
    s = applyMessage(s, { t: "error", ...env, code: "x", message: "y" });
    expect(s).toBe(before);
  });
  test("a fresh first page replaces the node set; health for unknown nodes is ignored", () => {
    let s = applyMessage(emptyState(), {
      t: "snapshot",
      ...env,
      seq: 3,
      page: 0,
      pages: 1,
      nodes: [node("n1")],
      at: 0,
    });
    s = applyMessage(s, {
      t: "snapshot",
      ...env,
      seq: 8,
      page: 0,
      pages: 1,
      nodes: [node("n9")],
      at: 0,
    });
    expect([...s.nodes.keys()]).toEqual(["n9"]);
    s = applyMessage(s, { t: "nodeHealth", ...env, seq: 9, nodeId: "ghost", health: "slow" });
    expect(s.nodes.size).toBe(1);
  });
});
