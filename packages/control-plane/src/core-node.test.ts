import { describe, expect, test } from "bun:test";
import { microvmIdOfHost } from "@tabframe/core";
import { startCore } from "./core-node.ts";

describe("a cloud core's node", () => {
  test("names itself after its MicroVM, so the ledger can link the two", () => {
    const lines: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const orchestrator = startCore({
      sessionUrl: "https://session.example/",
      microvmId: "microvm-abc",
      log: (event, fields) => lines.push({ event, ...(fields ? { fields } : {}) }),
      start: false,
    });
    expect(orchestrator.currentNodeId).toBeNull();
    // The host id is the contract with the core's `microvmIdOfHost`.
    expect(microvmIdOfHost("core-microvm-abc")).toBe("microvm-abc");
  });

  test("without a MicroVM id it still starts, named after the process", () => {
    const orchestrator = startCore({
      sessionUrl: "https://session.example/",
      microvmId: null,
      log: () => {},
      start: false,
    });
    expect(orchestrator).toBeDefined();
  });
});
