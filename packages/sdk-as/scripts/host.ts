// A minimal Node host for Tabframe programs: instantiates a module with the five `tf` imports
// backed by an in-memory filesystem, and calls `plan` and `run` through the ABI. Used by the
// goldens script and the tests; the real sandbox (WP1.4) implements the same imports with caps,
// deadlines, and the store behind them.
import {
  AbiError,
  decodeStageSpec,
  encodePlanInput,
  encodeRunInput,
  type ParamTable,
  type StageSpec,
} from "@tabframe/protocol";

export const ALLOWED_IMPORTS = new Set([
  "tf.stat",
  "tf.read",
  "tf.write",
  "tf.list",
  "tf.log",
  "env.abort",
]);

export interface HostOptions {
  /** Path → bytes visible to `stat`, `read`, and `list`. */
  files?: Map<string, Uint8Array>;
}

export interface ProgramInstance {
  plan(stage: number, params: ParamTable, hints?: ParamTable): StageSpec;
  run(stage: number, taskIndex: number, taskCount: number, input: Uint8Array): Uint8Array;
  readonly writes: Map<string, Uint8Array>;
  readonly logs: string[];
}

export class ProgramError extends Error {}

/** Validate the module's import table against the ABI's allowlist and check a memory maximum is declared. */
export function checkModule(module: WebAssembly.Module): { imports: string[]; exports: string[] } {
  const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
  const bad = imports.filter((i) => !ALLOWED_IMPORTS.has(i));
  if (bad.length) throw new ProgramError(`forbidden imports: ${bad.join(", ")}`);
  const exports = WebAssembly.Module.exports(module).map((e) => e.name);
  for (const required of ["memory", "alloc", "run", "plan"]) {
    if (!exports.includes(required)) throw new ProgramError(`missing export ${required}`);
  }
  return { imports, exports };
}

const utf8 = new TextDecoder();

/** Instantiate fresh (design §4.2: no state leaks between tasks) and wrap the ABI. */
export async function instantiate(
  module: WebAssembly.Module,
  opts: HostOptions = {},
): Promise<ProgramInstance> {
  const files = opts.files ?? new Map<string, Uint8Array>();
  const writes = new Map<string, Uint8Array>();
  const logs: string[] = [];
  let memory: WebAssembly.Memory | null = null;
  const bytes = () => new Uint8Array((memory as WebAssembly.Memory).buffer);
  const readPath = (ptr: number, len: number) => utf8.decode(bytes().subarray(ptr, ptr + len));
  const lookup = (path: string) => writes.get(path) ?? files.get(path);

  const imports: WebAssembly.Imports = {
    env: {
      abort(msgPtr: number, filePtr: number, line: number, col: number) {
        const asString = (p: number) => {
          if (!p) return "";
          const view = new DataView((memory as WebAssembly.Memory).buffer);
          const len = view.getUint32(p - 4, true);
          return new TextDecoder("utf-16le").decode(bytes().subarray(p, p + len));
        };
        throw new ProgramError(`trap: ${asString(msgPtr)} (${asString(filePtr)}:${line}:${col})`);
      },
    },
    tf: {
      stat(pathPtr: number, pathLen: number): bigint {
        const f = lookup(readPath(pathPtr, pathLen));
        return f ? BigInt(f.length) : -1n;
      },
      read(pathPtr: number, pathLen: number, offset: number, dst: number, dstLen: number): number {
        const f = lookup(readPath(pathPtr, pathLen));
        if (!f) return -1;
        if (offset < 0 || offset > f.length) return -2;
        const n = Math.min(dstLen, f.length - offset);
        bytes().set(f.subarray(offset, offset + n), dst);
        return n;
      },
      write(pathPtr: number, pathLen: number, src: number, srcLen: number): number {
        writes.set(readPath(pathPtr, pathLen), bytes().slice(src, src + srcLen));
        return 0;
      },
      list(prefixPtr: number, prefixLen: number, dst: number, dstLen: number): number {
        const prefix = readPath(prefixPtr, prefixLen);
        const paths = [...new Set([...files.keys(), ...writes.keys()])]
          .filter((p) => p.startsWith(prefix))
          .sort();
        const text = new TextEncoder().encode(paths.join("\n"));
        if (text.length <= dstLen) bytes().set(text, dst);
        return text.length;
      },
      log(src: number, len: number) {
        logs.push(utf8.decode(bytes().subarray(src, src + len)));
      },
    },
  };
  const instance = await WebAssembly.instantiate(module, imports);
  memory = instance.exports.memory as WebAssembly.Memory;
  const alloc = instance.exports.alloc as (len: number) => number;
  const planFn = instance.exports.plan as (ptr: number, len: number) => number;
  const runFn = instance.exports.run as (ptr: number, len: number) => number;

  function call(fn: (ptr: number, len: number) => number, input: Uint8Array): Uint8Array {
    const ptr = alloc(input.length);
    bytes().set(input, ptr);
    const pair = fn(ptr, input.length);
    const view = new DataView((memory as WebAssembly.Memory).buffer);
    const outPtr = view.getUint32(pair, true);
    const outLen = view.getUint32(pair + 4, true);
    return bytes().slice(outPtr, outPtr + outLen);
  }

  return {
    writes,
    logs,
    plan(stage, params, hints = {}) {
      const out = call(planFn, encodePlanInput({ stage, params, hints }));
      try {
        return decodeStageSpec(out);
      } catch (err) {
        if (err instanceof AbiError) throw new ProgramError(`invalid stage spec: ${err.message}`);
        throw err;
      }
    },
    run(stage, taskIndex, taskCount, input) {
      return call(runFn, encodeRunInput({ stage, taskIndex, taskCount, input }));
    },
  };
}

/** The module's declared memory limits in 64 KiB pages; `max` is null when the module declares none. */
export function memoryLimits(wasm: Uint8Array): { min: number; max: number | null } {
  let pos = 8; // magic + version
  const leb = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = wasm[pos++] as number;
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
  };
  while (pos < wasm.length) {
    const id = wasm[pos++];
    const size = leb();
    const end = pos + size;
    if (id === 5) {
      const count = leb();
      if (count > 0) {
        const flags = leb();
        const min = leb();
        const max = flags & 1 ? leb() : null;
        return { min, max };
      }
    }
    pos = end;
  }
  return { min: 0, max: null };
}

export interface StagedStage {
  name: string;
  taskCount: number;
  outputs: Uint8Array[];
  /** sha-256 hex of each task output, by task index. */
  hashes: string[];
  logs: string[][];
}

export interface StagedRun {
  stages: StagedStage[];
  /** The filesystem at the end: bundle inputs, every `/out/<stage>/<task>`, every write. */
  files: Map<string, Uint8Array>;
  /** The last stage's output when it had exactly one task (the `bars` and `text` views), else null. */
  final: Uint8Array | null;
  followUp: ParamTable | null;
}

/**
 * Run a whole execution single-threaded the way the control plane would (design §5.2, §5.4):
 * plan each stage, run its tasks in fresh instances against the filesystem as of the stage start,
 * land outputs at `/out/<stage>/<task>`, fold writes (two tasks writing different bytes to one
 * path is a program bug), and stop at `done`. Goldens and tests compare against this.
 */
export async function runStaged(
  module: WebAssembly.Module,
  inputs: Map<string, Uint8Array>,
  params: ParamTable,
  opts: { hints?: ParamTable; maxStages?: number } = {},
): Promise<StagedRun> {
  const { createHash } = await import("node:crypto");
  let files = new Map(inputs);
  const stages: StagedStage[] = [];
  const maxStages = opts.maxStages ?? 16;
  for (let s = 0; s < maxStages; s++) {
    const planner = await instantiate(module, { files });
    const spec = planner.plan(s, params, opts.hints ?? {});
    const next = new Map(files);
    for (const [p, b] of planner.writes) next.set(p, b);
    if (spec.kind === "done") {
      const last = stages[stages.length - 1];
      return {
        stages,
        files: next,
        final: last && last.outputs.length === 1 ? (last.outputs[0] as Uint8Array) : null,
        followUp: spec.next,
      };
    }
    const outputs: Uint8Array[] = [];
    const hashes: string[] = [];
    const logs: string[][] = [];
    const written = new Map<string, Uint8Array>();
    for (let i = 0; i < spec.tasks.length; i++) {
      const task = spec.tasks[i] as (typeof spec.tasks)[number];
      const inst = await instantiate(module, { files });
      const out = inst.run(s, i, spec.tasks.length, task.input);
      outputs.push(out);
      hashes.push(createHash("sha256").update(out).digest("hex"));
      logs.push(inst.logs);
      next.set(`/out/${s}/${i}`, out);
      for (const [p, b] of inst.writes) {
        const seen = written.get(p);
        if (seen && !sameBytes(seen, b))
          throw new ProgramError(`write conflict at ${p} in stage ${s} (${spec.name})`);
        written.set(p, b);
        next.set(p, b);
      }
    }
    stages.push({ name: spec.name, taskCount: spec.tasks.length, outputs, hashes, logs });
    files = next;
  }
  throw new ProgramError(`no done after ${maxStages} stages`);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Compile once, instantiate per call. */
export async function loadProgram(
  wasm: Uint8Array,
): Promise<{ module: WebAssembly.Module; imports: string[]; exports: string[] }> {
  const module = await WebAssembly.compile(wasm);
  const { imports, exports } = checkModule(module);
  return { module, imports, exports };
}
