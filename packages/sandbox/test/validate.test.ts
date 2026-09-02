import { describe, expect, test } from "bun:test";
import { LIMITS } from "@tabframe/protocol";
import { readMemoryLimits, validateCompiled, validateModuleBytes } from "../src/validate.ts";
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
        WebAssembly.Module.exports(v.module)
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
      const imports = WebAssembly.Module.imports(v.module).map((i) => `${i.module}.${i.name}`);
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
