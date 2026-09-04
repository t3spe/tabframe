import { describe, expect, test } from "bun:test";
import { LIMITS } from "@tabframe/protocol";
import {
  checkShape,
  countMemories,
  readMemoryLimits,
  readModuleShape,
  validateCompiled,
  validateModuleBytes,
} from "../src/validate.ts";
import { compileFixture } from "./compile.ts";
import { limits } from "./helpers.ts";

describe("validateModuleBytes", () => {
  test("a well-formed program with a declared memory maximum passes", async () => {
    const bytes = await compileFixture("echo", { maximumMemory: 256 });
    const v = validateModuleBytes(bytes, limits);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.memory.max).toBe(256);
      expect(v.memory.shared).toBe(false);
      expect(v.memory.memory64).toBe(false);
      expect(
        WebAssembly.Module.exports(v.module as WebAssembly.Module)
          .map((e) => e.name)
          .sort(),
      ).toEqual(["alloc", "memory", "plan", "run"]);
    }
  });

  test("a forbidden import is named in the rejection", async () => {
    const bytes = await compileFixture("time", { maximumMemory: 256 });
    const v = validateModuleBytes(bytes, limits);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/forbidden import env\.(Date\.now|seed|.*)/);
  });

  test("the allowed imports are accepted", async () => {
    const fs = await compileFixture("fs", { maximumMemory: 256 });
    expect(validateModuleBytes(fs, limits).ok).toBe(true);
    const trap = await compileFixture("trap", { maximumMemory: 256 });
    const v = validateModuleBytes(trap, limits);
    expect(v.ok).toBe(true);
    if (v.ok) {
      const imports = WebAssembly.Module.imports(v.module as WebAssembly.Module).map(
        (i) => `${i.module}.${i.name}`,
      );
      expect(imports).toContain("env.abort");
    }
  });

  test("missing exports, missing or oversized memory maximum, size cap, garbage", async () => {
    const noplan = await compileFixture("noplan", { maximumMemory: 256 });
    const v1 = validateModuleBytes(noplan, limits);
    expect(!v1.ok && v1.reason).toBe("missing export plan (function)");

    const noMax = await compileFixture("echo");
    const v2 = validateModuleBytes(noMax, limits);
    expect(!v2.ok && v2.reason).toMatch(/memory maximum is required/);

    const tooBig = await compileFixture("echo", { maximumMemory: 1000 });
    const v3 = validateModuleBytes(tooBig, limits);
    expect(!v3.ok && v3.reason).toMatch(/1000 pages exceeds the cap of 256/);

    const v4 = validateModuleBytes(new Uint8Array(LIMITS.maxModuleBytes + 1), limits);
    expect(!v4.ok && v4.reason).toMatch(/cap/);

    const v5 = validateModuleBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), limits);
    expect(!v5.ok && v5.reason).toBe("not a valid WebAssembly module");
  });
});

describe("readMemoryLimits", () => {
  test("reads min and max from the memory section", async () => {
    const withMax = readMemoryLimits(await compileFixture("echo", { maximumMemory: 256 }));
    expect(withMax?.max).toBe(256);
    expect(withMax?.min).toBeGreaterThanOrEqual(0);
    const without = readMemoryLimits(await compileFixture("echo"));
    expect(without?.max).toBeNull();
  });
  test("returns null for junk, a short buffer, or a module without a memory section", () => {
    expect(readMemoryLimits(new Uint8Array([0, 0, 0]))).toBeNull();
    expect(readMemoryLimits(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
    // Magic + version and nothing else: a valid empty module with no memory.
    expect(readMemoryLimits(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))).toBeNull();
    // A truncated section header must not throw.
    expect(readMemoryLimits(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 5, 0x80]))).toBeNull();
  });
});

describe("validateCompiled", () => {
  test("accepts a compiled program and rejects one without the required exports", async () => {
    const ok = new WebAssembly.Module(await compileFixture("echo", { maximumMemory: 256 }));
    expect(validateCompiled(ok).ok).toBe(true);
    const bad = new WebAssembly.Module(await compileFixture("noplan", { maximumMemory: 256 }));
    expect(validateCompiled(bad).ok).toBe(false);
  });
});

describe("one memory only (WP8.1)", () => {
  // A module whose memory section declares two memories: the first small and capped, the second
  // without a maximum. Multi-memory is on by default in current engines, so the second one could
  // grow past the cap the design promises.
  const twoMemories = new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00, // magic, version
    0x05,
    0x06,
    0x02, // memory section, 6 bytes, 2 memories
    0x01,
    0x01,
    0x01, // memory 0: min 1, max 1
    0x00,
    0x01, // memory 1: min 1, no maximum
  ]);
  test("the memory section's count is read, and a second memory is refused", () => {
    expect(countMemories(twoMemories)).toBe(2);
    const v = validateModuleBytes(twoMemories, { memoryPagesMax: 1024 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/memories; one is allowed|not a valid WebAssembly module/);
  });
});

describe("readModuleShape (WP8.2)", () => {
  test("reads the imports and exports from the binary and agrees with the compiled module", async () => {
    const bytes = await compileFixture("echo", { maximumMemory: 256 });
    const shape = readModuleShape(bytes);
    expect(shape).not.toBeNull();
    const compiled = new WebAssembly.Module(bytes as unknown as BufferSource);
    expect(shape?.exports.map((e) => `${e.name}:${e.kind}`).sort()).toEqual(
      WebAssembly.Module.exports(compiled)
        .map((e) => `${e.name}:${e.kind}`)
        .sort(),
    );
    expect(shape?.imports.map((i) => `${i.module}.${i.name}:${i.kind}`).sort()).toEqual(
      WebAssembly.Module.imports(compiled)
        .map((i) => `${i.module}.${i.name}:${i.kind}`)
        .sort(),
    );
    expect(checkShape(shape as NonNullable<typeof shape>).ok).toBe(true);
  });

  test("the no-compile validation names a forbidden import and returns no module", async () => {
    const bytes = await compileFixture("time", { maximumMemory: 256 });
    const v = validateModuleBytes(bytes, limits, { compile: false });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("forbidden import");
    const good = validateModuleBytes(await compileFixture("echo", { maximumMemory: 256 }), limits, {
      compile: false,
    });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.module).toBeNull();
  });

  test("a truncated import section is malformed, not a crash", () => {
    // magic + version, then an import section claiming ten entries with one byte of payload
    const bytes = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 2, 1, 10]);
    expect(readModuleShape(bytes)).toBeNull();
    expect(readModuleShape(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))?.exports).toEqual([]);
  });
});
