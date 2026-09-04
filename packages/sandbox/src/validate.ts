import { LIMITS } from "@tabframe/protocol";

/** The only imports a program may declare (design §5.3, §5.5). */
export const ALLOWED_IMPORTS: Readonly<Record<string, ReadonlySet<string>>> = {
  tf: new Set(["stat", "read", "write", "list", "log"]),
  env: new Set(["abort"]),
};

export const REQUIRED_EXPORTS = ["memory", "alloc", "run", "plan"] as const;

export interface MemoryLimits {
  min: number;
  max: number | null;
  shared: boolean;
  memory64: boolean;
}

export type Validation =
  | { ok: true; memory: MemoryLimits; module: WebAssembly.Module }
  | { ok: false; reason: string };

/**
 * Validate program bytes before anything is instantiated: size, well-formedness, a declared memory
 * maximum under the cap, the import allowlist, and the required exports.
 */
export function validateModuleBytes(
  bytes: Uint8Array,
  limits: { memoryPagesMax: number },
): Validation {
  if (bytes.length > LIMITS.maxModuleBytes) {
    return { ok: false, reason: `module is ${bytes.length} bytes, cap ${LIMITS.maxModuleBytes}` };
  }
  if (!WebAssembly.validate(asSource(bytes))) {
    return { ok: false, reason: "not a valid WebAssembly module" };
  }
  // One memory only (WP8.1): with multi-memory a module could declare a small first memory and
  // grow an unbounded second one past the cap the design promises.
  const memories = countMemories(bytes);
  if (memories > 1)
    return { ok: false, reason: `module declares ${memories} memories; one is allowed` };
  const memory = readMemoryLimits(bytes);
  if (!memory) return { ok: false, reason: "module declares no memory" };
  if (memory.shared) return { ok: false, reason: "shared memory is not allowed" };
  if (memory.memory64) return { ok: false, reason: "memory64 is not allowed" };
  if (memory.max === null) return { ok: false, reason: "a declared memory maximum is required" };
  if (memory.max > limits.memoryPagesMax) {
    return {
      ok: false,
      reason: `memory maximum ${memory.max} pages exceeds the cap of ${limits.memoryPagesMax}`,
    };
  }
  let module: WebAssembly.Module;
  try {
    module = new WebAssembly.Module(asSource(bytes));
  } catch (err) {
    return { ok: false, reason: `compile failed: ${String(err)}` };
  }
  const shape = validateCompiled(module);
  if (!shape.ok) return shape;
  return { ok: true, memory, module };
}

/** The WebAssembly API wants a view over a plain ArrayBuffer; our bytes may sit on any buffer. */
function asSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

/** Import allowlist and required exports of an already compiled module. */
export function validateCompiled(
  module: WebAssembly.Module,
): { ok: true } | { ok: false; reason: string } {
  for (const imp of WebAssembly.Module.imports(module)) {
    const allowed = ALLOWED_IMPORTS[imp.module];
    if (!allowed?.has(imp.name) || imp.kind !== "function") {
      return { ok: false, reason: `forbidden import ${imp.module}.${imp.name} (${imp.kind})` };
    }
  }
  const exports = new Map(WebAssembly.Module.exports(module).map((e) => [e.name, e.kind]));
  for (const name of REQUIRED_EXPORTS) {
    const kind = exports.get(name);
    const want = name === "memory" ? "memory" : "function";
    if (kind !== want) return { ok: false, reason: `missing export ${name} (${want})` };
  }
  return { ok: true };
}

/**
 * Read the memory section's limits straight from the binary; the JS API does not expose them.
 * Returns null when the module defines no memory of its own.
 */
/** How many memories the module's memory section declares (imported memories are refused by the allowlist). */
export function countMemories(bytes: Uint8Array): number {
  let pos = 8;
  const leb = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = bytes[pos++];
      if (b === undefined) throw new RangeError("truncated");
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result >>> 0;
      shift += 7;
      if (shift > 35) throw new RangeError("bad LEB128");
    }
  };
  try {
    while (pos < bytes.length) {
      const id = bytes[pos++];
      const size = leb();
      const end = pos + size;
      if (id === 5) return leb();
      pos = end;
    }
  } catch {
    return 0;
  }
  return 0;
}

export function readMemoryLimits(bytes: Uint8Array): MemoryLimits | null {
  if (bytes.length < 8) return null;
  if (bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) return null;
  let pos = 8;
  const leb = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = bytes[pos++];
      if (b === undefined) throw new RangeError("truncated");
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result >>> 0;
      shift += 7;
      if (shift > 35) throw new RangeError("bad LEB128");
    }
  };
  try {
    while (pos < bytes.length) {
      const id = bytes[pos++];
      const size = leb();
      const end = pos + size;
      if (id === 5) {
        const count = leb();
        if (count === 0) return null;
        const flags = leb();
        const memory64 = (flags & 0x04) !== 0;
        const shared = (flags & 0x02) !== 0;
        const min = leb();
        const max = (flags & 0x01) !== 0 ? leb() : null;
        return { min, max, shared, memory64 };
      }
      pos = end;
    }
  } catch {
    return null;
  }
  return null;
}
