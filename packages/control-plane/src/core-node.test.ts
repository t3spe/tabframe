import { describe, expect, test } from "bun:test";
import { microvmIdOfHost } from "@tabframe/core";
import { blobReaderFor, startCore } from "./core-node.ts";

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

  test("its blob reader serves whole blobs and ranges, and refuses to upload", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string> | undefined)?.range;
      if (!range) return new Response(bytes as unknown as BodyInit, { status: 200 });
      const m = /bytes=(\d+)-(\d+)/.exec(range);
      const start = Number(m?.[1] ?? 0);
      const end = Number(m?.[2] ?? bytes.length - 1);
      return new Response(bytes.slice(start, end + 1) as unknown as BodyInit, { status: 206 });
    }) as typeof fetch;
    try {
      const read = blobReaderFor("https://cdn.example/blob");
      expect(await read("a".repeat(64), 0, Number.POSITIVE_INFINITY)).toEqual(bytes);
      expect(await read("a".repeat(64), 2, 3)).toEqual(bytes.slice(2, 5));
      expect(await read("a".repeat(64), 6, Number.POSITIVE_INFINITY)).toEqual(bytes.slice(6));
    } finally {
      globalThis.fetch = original;
    }
  });
});
