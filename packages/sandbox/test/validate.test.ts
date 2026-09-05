import { describe, expect, test } from "bun:test";
import { LIMITS } from "@tabframe/protocol";
import {
  checkShape,
  compileValidated,
  countMemories,
  inspectModuleBytes,
  readMemoryLimits,
  readModuleShape,
  validateCompiled,
  validateModuleBytes,
} from "../src/validate.ts";
import { readModuleSections } from "../src/wasm-binary.ts";
import { compileFixture } from "./compile.ts";
import { limits } from "./helpers.ts";

const wasm = (...tail: number[]) => new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...tail]);

describe("compileValidated", () => {
  test("a well-formed program with a declared memory maximum passes and is compiled", async () => {
    const bytes = await compileFixture("echo");
    const v = compileValidated(bytes, limits);
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
    const bytes = await compileFixture("time");
    const v = compileValidated(bytes, limits);
    expect(!v.ok && v.reason).toBe("forbidden import env.Date.now (function)");
  });

  test("the allowed imports are accepted", async () => {
    const fs = await compileFixture("fs");
    expect(compileValidated(fs, limits).ok).toBe(true);
    const trap = await compileFixture("trap");
    const v = compileValidated(trap, limits);
    expect(v.ok).toBe(true);
    if (v.ok) {
      const imports = WebAssembly.Module.imports(v.module).map((i) => `${i.module}.${i.name}`);
      expect(imports).toContain("env.abort");
    }
  });

  test("missing exports, missing or oversized memory maximum, size cap, garbage", async () => {
    const noplan = await compileFixture("noplan");
    const v1 = compileValidated(noplan, limits);
    expect(!v1.ok && v1.reason).toBe("missing export plan (function)");

    const noMax = await compileFixture("echo", { maximumMemory: null });
    const v2 = compileValidated(noMax, limits);
    expect(!v2.ok && v2.reason).toMatch(/memory maximum is required/);

    const tooBig = await compileFixture("echo", { maximumMemory: 1000 });
    const v3 = compileValidated(tooBig, limits);
    expect(!v3.ok && v3.reason).toMatch(/1000 pages exceeds the cap of 256/);

    const v4 = compileValidated(new Uint8Array(LIMITS.maxModuleBytes + 1), limits);
    expect(!v4.ok && v4.reason).toMatch(/cap/);

    const v5 = compileValidated(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), limits);
    expect(!v5.ok && v5.reason).toBe("not a valid WebAssembly module");
  });
});

describe("inspectModuleBytes", () => {
  test("says what compileValidated says, without a module", async () => {
    const good = inspectModuleBytes(await compileFixture("echo"), limits);
    expect(good).toMatchObject({ ok: true, memory: { max: 256, shared: false, memory64: false } });
    expect("module" in good).toBe(false);
    const bad = inspectModuleBytes(await compileFixture("time"), limits);
    expect(!bad.ok && bad.reason).toContain("forbidden import");
  });

  test("a module with no memory section is refused", () => {
    expect(inspectModuleBytes(wasm(), limits)).toEqual({
      ok: false,
      reason: "module declares no memory",
    });
  });
});

describe("validateModuleBytes keeps its older shape", () => {
  test("compiles by default and returns module: null with compile: false", async () => {
    const bytes = await compileFixture("echo");
    const compiled = validateModuleBytes(bytes, limits);
    expect(compiled.ok && compiled.module).toBeInstanceOf(WebAssembly.Module);
    const inspected = validateModuleBytes(bytes, limits, { compile: false });
    expect(inspected.ok && inspected.module).toBeNull();
    const rejected = validateModuleBytes(await compileFixture("time"), limits, {
      compile: false,
    });
    expect(!rejected.ok && rejected.reason).toBe("forbidden import env.Date.now (function)");
  });
});

describe("readMemoryLimits", () => {
  test("reads min and max from the memory section", async () => {
    const withMax = readMemoryLimits(await compileFixture("echo"));
    expect(withMax?.max).toBe(256);
    expect(withMax?.min).toBeGreaterThanOrEqual(0);
    const without = readMemoryLimits(await compileFixture("echo", { maximumMemory: null }));
    expect(without?.max).toBeNull();
  });
  test("returns null for junk, a short buffer, or a module without a memory section", () => {
    expect(readMemoryLimits(new Uint8Array([0, 0, 0]))).toBeNull();
    expect(readMemoryLimits(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
    // Magic + version and nothing else: a valid empty module with no memory.
    expect(readMemoryLimits(wasm())).toBeNull();
    // A truncated section header must not throw.
    expect(readMemoryLimits(wasm(5, 0x80))).toBeNull();
  });
});

describe("validateCompiled", () => {
  test("accepts a compiled program and rejects one without the required exports", async () => {
    const ok = new WebAssembly.Module(await compileFixture("echo"));
    expect(validateCompiled(ok).ok).toBe(true);
    const bad = new WebAssembly.Module(await compileFixture("noplan"));
    expect(validateCompiled(bad).ok).toBe(false);
  });
});

describe("a second memory is refused", () => {
  // A memory section declaring two memories: the first small and capped, the second without a
  // maximum. Multi-memory is on by default in current engines, so the second one could grow past
  // the cap the design promises.
  const twoMemories = wasm(
    0x05,
    0x06,
    0x02, // memory section, 6 bytes, 2 memories
    0x01,
    0x01,
    0x01, // memory 0: min 1, max 1
    0x00,
    0x01, // memory 1: min 1, no maximum
  );
  test("the memory section's count is read, and the module does not validate", () => {
    expect(countMemories(twoMemories)).toBe(2);
    expect(readModuleSections(twoMemories)?.memories).toEqual([
      { min: 1, max: 1, shared: false, memory64: false },
      { min: 1, max: null, shared: false, memory64: false },
    ]);
    const v = inspectModuleBytes(twoMemories, { memoryPagesMax: 1024 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/memories; one is allowed|not a valid WebAssembly module/);
  });
});

describe("readModuleSections", () => {
  test("reads the imports and exports from the binary and agrees with the compiled module", async () => {
    const bytes = await compileFixture("fs");
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

  test("a truncated or overrunning section is malformed, not a crash", () => {
    // An import section claiming ten entries with one byte of payload.
    expect(readModuleSections(wasm(2, 1, 10))).toBeNull();
    // An export section whose one entry runs past the section's declared size.
    expect(readModuleSections(wasm(7, 1, 1, 3, 0x61, 0x62, 0x63, 0, 0))).toBeNull();
    // A section whose declared size runs past the buffer.
    expect(readModuleSections(wasm(5, 20, 1, 0, 1))).toBeNull();
    // Not a module at all.
    expect(readModuleSections(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
    expect(countMemories(new Uint8Array([5, 1, 1]))).toBe(0);
    // The empty module: every section absent.
    expect(readModuleSections(wasm())).toEqual({ imports: [], exports: [], memories: [] });
  });
});
