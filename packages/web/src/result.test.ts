import { describe, expect, test } from "bun:test";
import { encodeBars } from "@tabframe/protocol";
import {
  barRows,
  comparePaths,
  decodeText,
  finalOutput,
  fmtBytes,
  fmtValue,
  groupFiles,
  hexHead,
  listFiles,
  looksLikeText,
  parseManifest,
  previewOf,
  readBars,
} from "./result.ts";

const H = (c: string) => c.repeat(64);
const manifest = {
  version: 1 as const,
  files: {
    "/out/0/10": { hash: H("a"), size: 10 },
    "/out/0/2": { hash: H("b"), size: 2 },
    "/in/corpus.txt": { hash: H("c"), size: 1_220_332 },
    "/program.wasm": { hash: H("d"), size: 20_655 },
    "/out/1/0": { hash: H("e"), size: 300 },
    "/manifest.json": { hash: H("f"), size: 120 },
    "/state/acc": { hash: H("1"), size: 8 },
  },
};
const bytes = (s: string) => new TextEncoder().encode(s);

describe("the files panel model", () => {
  test("lists paths in path order with numeric segments sorted as numbers", () => {
    expect(listFiles(manifest).map((f) => f.path)).toEqual([
      "/in/corpus.txt",
      "/manifest.json",
      "/out/0/2",
      "/out/0/10",
      "/out/1/0",
      "/program.wasm",
      "/state/acc",
    ]);
    expect(comparePaths("/out/0/2", "/out/0/10")).toBeLessThan(0);
    expect(comparePaths("/out/1/0", "/out/0/10")).toBeGreaterThan(0);
    expect(comparePaths("/a", "/a")).toBe(0);
  });
  test("groups the bundle's own files, inputs, each stage's outputs, then the rest", () => {
    const groups = groupFiles(listFiles(manifest));
    expect(groups.map((g) => g.label)).toEqual(["/", "/in/", "/out/0/", "/out/1/", "/state/"]);
    expect(groups[0]?.files.map((f) => f.path)).toEqual(["/manifest.json", "/program.wasm"]);
    expect(groups[2]?.files.map((f) => f.path)).toEqual(["/out/0/2", "/out/0/10"]);
    expect(groups[2]?.bytes).toBe(12);
    expect(groups[1]?.bytes).toBe(1_220_332);
  });
  test("parses a manifest blob and rejects one that is not a manifest", () => {
    const parsed = parseManifest(bytes(JSON.stringify(manifest)));
    expect(Object.keys(parsed.files)).toHaveLength(7);
    expect(() => parseManifest(bytes('{"version":2,"files":{}}'))).toThrow();
    expect(() => parseManifest(bytes("nope"))).toThrow();
  });
});

describe("the final output", () => {
  test("is the single result of the last stage", () => {
    expect(finalOutput(manifest)?.path).toBe("/out/1/0");
  });
  test("is nothing when the last stage has several outputs, or no stage has run", () => {
    const two = {
      version: 1 as const,
      files: { "/out/0/0": { hash: H("a"), size: 1 }, "/out/0/1": { hash: H("b"), size: 1 } },
    };
    expect(finalOutput(two)).toBeNull();
    expect(finalOutput({ version: 1, files: { "/in/x": { hash: H("a"), size: 1 } } })).toBeNull();
  });
});

describe("bars and text", () => {
  const payload = encodeBars([
    { label: "of", value: 6620 },
    { label: "the", value: 14529 },
    { label: "and", value: 6446 },
  ]);
  test("reads a bars payload and refuses anything else", () => {
    const r = readBars(payload);
    expect(r.ok && r.bars.length).toBe(3);
    const bad = readBars(bytes("TFBR but not really"));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.length).toBeGreaterThan(0);
  });
  test("rows are longest first, scaled to the widest, capped", () => {
    const r = readBars(payload);
    if (!r.ok) throw new Error("bars");
    const rows = barRows(r.bars, 2);
    expect(rows.map((b) => b.label)).toEqual(["the", "of"]);
    expect(rows[0]?.fraction).toBe(1);
    expect(rows[1]?.fraction).toBeCloseTo(6620 / 14529, 5);
    expect(barRows([]).length).toBe(0);
    expect(barRows([{ label: "z", value: 0 }])[0]?.fraction).toBe(0);
  });
  test("text is detected and capped; binary is not text", () => {
    expect(looksLikeText(bytes("hello\nworld"))).toBe(true);
    expect(looksLikeText(new Uint8Array([0, 1, 2, 3]))).toBe(false);
    expect(looksLikeText(new Uint8Array([0xff, 0xfe, 0x41]))).toBe(false);
    const long = decodeText(bytes("x".repeat(100)), 10);
    expect(long.text).toBe("x".repeat(10));
    expect(long.truncated).toBe(true);
    expect(decodeText(bytes("short")).truncated).toBe(false);
  });
});

describe("previews", () => {
  test("a bars payload draws, a manifest lists, text reads, a tile is an image, bytes are hex", () => {
    const payload = encodeBars([{ label: "a", value: 1 }]);
    expect(previewOf(payload, null)).toMatchObject({ kind: "bars" });
    expect(previewOf(bytes(JSON.stringify(manifest)), null)).toMatchObject({ kind: "manifest" });
    expect(previewOf(bytes("{ not a manifest"), null)).toMatchObject({ kind: "text" });
    expect(previewOf(bytes("plain words"), null)).toEqual({
      kind: "text",
      text: "plain words",
      truncated: false,
    });
    const tile = new Uint8Array(64 * 64 * 4);
    expect(previewOf(tile, { w: 64, h: 64 })).toEqual({ kind: "image", w: 64, h: 64 });
    expect(previewOf(tile, null)).toMatchObject({ kind: "bytes" });
    expect(hexHead(new Uint8Array([0, 255, 16]))).toBe("00 ff 10");
  });
  test("formatting", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2048)).toBe("2.0 KiB");
    expect(fmtBytes(3 * 1024 * 1024)).toBe("3.0 MiB");
    expect(fmtValue(14529)).toBe("14,529");
    expect(fmtValue(0.12345)).toBe("0.123");
  });
});
