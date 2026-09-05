import { describe, expect, test } from "bun:test";
import { blobReaderFor, nodeDeps } from "./node-deps.ts";

describe("nodeDeps", () => {
  test("describes a one-worker core and carries the core token only when there is one", () => {
    const base = {
      sessionUrl: "https://session.example/",
      hostId: "core-x",
      log: () => {},
      onStatus: () => {},
    };
    const plain = nodeDeps(base);
    expect(plain.kind).toBe("core");
    expect(plain.cores).toBe(1);
    expect(plain.hostId).toBe("core-x");
    expect("coreToken" in plain).toBe(false);
    expect(nodeDeps({ ...base, coreToken: "t".repeat(32) }).coreToken).toBe("t".repeat(32));
  });
});

describe("blobReaderFor", () => {
  test("serves whole blobs and ranges, and refuses to upload", async () => {
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
