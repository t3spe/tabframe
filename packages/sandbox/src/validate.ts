import { LIMITS } from "@tabframe/protocol";
import { type MemoryLimits, type ModuleShape, readModuleSections } from "./wasm-binary.ts";

export type { MemoryLimits, ModuleShape } from "./wasm-binary.ts";

/** The only imports a program may declare (design §5.3, §5.5). */
export const ALLOWED_IMPORTS: Readonly<Record<string, ReadonlySet<string>>> = {
  tf: new Set(["stat", "read", "write", "list", "log"]),
  env: new Set(["abort"]),
};

export const REQUIRED_EXPORTS = ["memory", "alloc", "run", "plan"] as const;

export type Rejection = { ok: false; reason: string };
/** What the bytes say about a module, without compiling it. */
export type Inspection = { ok: true; memory: MemoryLimits } | Rejection;
/** An inspected module, compiled. */
export type Compiled = { ok: true; memory: MemoryLimits; module: WebAssembly.Module } | Rejection;
/** `validateModuleBytes`'s result: `module` is null when compilation was not asked for. */
export type Validation =
  | { ok: true; memory: MemoryLimits; module: WebAssembly.Module | null }
  | Rejection;

/**
 * Everything a node checks before instantiating, read from the bytes alone: the size cap,
 * well-formedness, one memory with a declared maximum under the cap, the import allowlist, and the
 * required exports. Nothing is compiled: the control plane runs no program code (design §2), so a
 * stranger's eight megabytes never reach V8's compiler on its event loop.
 */
export function inspectModuleBytes(
  bytes: Uint8Array,
  limits: { memoryPagesMax: number },
): Inspection {
  if (bytes.length > LIMITS.maxModuleBytes) {
    return reject(`module is ${bytes.length} bytes, cap ${LIMITS.maxModuleBytes}`);
  }
  if (!WebAssembly.validate(asSource(bytes))) return reject("not a valid WebAssembly module");
  const sections = readModuleSections(bytes);
  if (!sections) return reject("malformed import or export section");
  // One memory only: with multi-memory a module could declare a small first memory and grow an
  // unbounded second one past the cap the design promises.
  if (sections.memories.length > 1) {
    return reject(`module declares ${sections.memories.length} memories; one is allowed`);
  }
  const memory = sections.memories[0];
  if (!memory) return reject("module declares no memory");
  if (memory.shared) return reject("shared memory is not allowed");
  if (memory.memory64) return reject("memory64 is not allowed");
  if (memory.max === null) return reject("a declared memory maximum is required");
  if (memory.max > limits.memoryPagesMax) {
    return reject(`memory maximum ${memory.max} pages exceeds the cap of ${limits.memoryPagesMax}`);
  }
  const shape = checkShape(sections);
  if (!shape.ok) return shape;
  return { ok: true, memory };
}

/** Inspect, then compile: the module is what `runTask` instantiates. */
export function compileValidated(bytes: Uint8Array, limits: { memoryPagesMax: number }): Compiled {
  const inspected = inspectModuleBytes(bytes, limits);
  if (!inspected.ok) return inspected;
  try {
    return { ok: true, memory: inspected.memory, module: new WebAssembly.Module(asSource(bytes)) };
  } catch (err) {
    return reject(`compile failed: ${String(err)}`);
  }
}

/**
 * The older entry point, kept for its callers: `compile: false` is `inspectModuleBytes` with
 * `module: null`; otherwise `compileValidated`.
 */
export function validateModuleBytes(
  bytes: Uint8Array,
  limits: { memoryPagesMax: number },
  opts: { compile?: boolean } = {},
): Validation {
  if (opts.compile === false) {
    const inspected = inspectModuleBytes(bytes, limits);
    return inspected.ok ? { ...inspected, module: null } : inspected;
  }
  return compileValidated(bytes, limits);
}

/** The allowlist and the required exports, on a parsed shape. */
export function checkShape(shape: ModuleShape): { ok: true } | Rejection {
  for (const imp of shape.imports) {
    const allowed = ALLOWED_IMPORTS[imp.module];
    if (!allowed?.has(imp.name) || imp.kind !== "function") {
      return reject(`forbidden import ${imp.module}.${imp.name} (${imp.kind})`);
    }
  }
  const exports = new Map(shape.exports.map((e) => [e.name, e.kind]));
  for (const name of REQUIRED_EXPORTS) {
    const kind = exports.get(name);
    const want = name === "memory" ? "memory" : "function";
    if (kind !== want) return reject(`missing export ${name} (${want})`);
  }
  return { ok: true };
}

/** The allowlist and the required exports of an already compiled module, through the JS API. */
export function validateCompiled(module: WebAssembly.Module): { ok: true } | Rejection {
  return checkShape({
    imports: WebAssembly.Module.imports(module),
    exports: WebAssembly.Module.exports(module),
  });
}

/** How many memories the memory section declares; 0 when the bytes do not parse. */
export function countMemories(bytes: Uint8Array): number {
  return readModuleSections(bytes)?.memories.length ?? 0;
}

/** The first memory's limits, or null when the module declares none or does not parse. */
export function readMemoryLimits(bytes: Uint8Array): MemoryLimits | null {
  return readModuleSections(bytes)?.memories[0] ?? null;
}

/** The import and export sections; null when the bytes do not parse. */
export function readModuleShape(bytes: Uint8Array): ModuleShape | null {
  const sections = readModuleSections(bytes);
  return sections ? { imports: sections.imports, exports: sections.exports } : null;
}

function reject(reason: string): Rejection {
  return { ok: false, reason };
}

/** The WebAssembly API wants a view over a plain ArrayBuffer; our bytes may sit on any buffer. */
function asSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}
