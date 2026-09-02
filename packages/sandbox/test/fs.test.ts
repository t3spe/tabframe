import { describe, expect, test } from "bun:test";
import { FsView, RC } from "../src/fs.ts";
import { CachingBlobReader } from "../src/types.ts";
import { blobs, dec, enc, H1, limits, MapReader, manifest } from "./helpers.ts";

describe("FsView", () => {
  test("stat, read, and list see the manifest and then this task's own writes", () => {
    const fs = new FsView(manifest, new MapReader(), limits);
    expect(fs.stat("/in/a.txt")).toBe(11);
    expect(fs.stat("/nope")).toBe(RC.notFound);
    expect(dec.decode(fs.read("/in/a.txt", 0, 100) as Uint8Array)).toBe("hello world");
    expect(dec.decode(fs.read("/in/a.txt", 6, 3) as Uint8Array)).toBe("wor");
    expect((fs.read("/in/a.txt", 11, 3) as Uint8Array).length).toBe(0);
    expect(fs.read("/nope", 0, 1)).toBe(RC.notFound);
    expect(fs.read("/in/a.txt", -1, 1)).toBe(RC.badArgs);
    expect(fs.read("/in/a.txt", 0, 1.5)).toBe(RC.badArgs);
    expect(fs.list("/in/")).toBe("/in/a.txt\n/in/b.txt");
    expect(fs.list("/out/")).toBe("");
    expect(fs.write("/out/x.txt", enc.encode("new"))).toBe(0);
    expect(fs.stat("/out/x.txt")).toBe(3);
    expect(dec.decode(fs.read("/out/x.txt", 0, 10) as Uint8Array)).toBe("new");
    expect(fs.list("/")).toBe("/in/a.txt\n/in/b.txt\n/out/x.txt");
    // Own writes shadow the manifest.
    expect(fs.write("/in/a.txt", enc.encode("shadow"))).toBe(0);
    expect(fs.stat("/in/a.txt")).toBe(6);
  });

  test("write enforces the path grammar and the caps; last write wins", () => {
    const fs = new FsView(manifest, new MapReader(), {
      ...limits,
      maxWriteFiles: 2,
      maxWriteBytes: 10,
    });
    expect(fs.write("relative", enc.encode("x"))).toBe(RC.badArgs);
    expect(fs.write("/a/../b", enc.encode("x"))).toBe(RC.badArgs);
    expect(fs.write("/a", enc.encode("12345"))).toBe(0);
    expect(fs.write("/b", enc.encode("123456"))).toBe(RC.capExceeded);
    expect(fs.write("/b", enc.encode("12345"))).toBe(0);
    expect(fs.write("/c", enc.encode("1"))).toBe(RC.capExceeded);
    expect(fs.write("/a", enc.encode("1"))).toBe(0);
    expect(fs.write("/b", enc.encode("123456789"))).toBe(0);
    expect(fs.writes.get("/b")?.length).toBe(9);
  });

  test("log is capped and marked truncated", () => {
    const fs = new FsView(manifest, new MapReader(), { ...limits, maxLogBytes: 10 });
    fs.appendLog("12345");
    fs.appendLog("678");
    expect(fs.logTruncated).toBe(false);
    fs.appendLog("901");
    expect(fs.logTruncated).toBe(true);
    fs.appendLog("ignored");
    expect(fs.log).toBe("12345678\n[log truncated]");
  });

  test("a manifest entry whose blob is missing reads as not found", () => {
    const fs = new FsView(manifest, new MapReader({}), limits);
    expect(fs.read("/in/a.txt", 0, 5)).toBe(RC.notFound);
    expect(fs.stat("/in/a.txt")).toBe(11);
  });
});

describe("CachingBlobReader", () => {
  test("fetches a blob once and serves ranges from memory; passes through misses", () => {
    const inner = new MapReader();
    const reader = new CachingBlobReader(inner);
    expect(dec.decode(reader.read(H1, 0, Number.POSITIVE_INFINITY) as Uint8Array)).toBe(
      "hello world",
    );
    expect(dec.decode(reader.read(H1, 6, 5) as Uint8Array)).toBe("world");
    expect((reader.read(H1, 50, 5) as Uint8Array).length).toBe(0);
    expect(inner.calls).toBe(1);
    expect(reader.read("f".repeat(64), 0, 1)).toBeNull();
    expect(reader.size).toBe(1);
  });
  test("evicts oldest-first past the byte cap", () => {
    const reader = new CachingBlobReader(new MapReader(), 12);
    reader.read(H1, 0, 1);
    reader.read("2".repeat(64), 0, 1);
    expect(reader.size).toBe(1);
    expect(dec.decode(reader.read("2".repeat(64), 0, 3) as Uint8Array)).toBe(
      dec.decode(blobs["2".repeat(64)] as Uint8Array),
    );
  });
});
