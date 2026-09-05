// The SDK's Node host: the sandbox's own `runTask` behind a per-call API for the program tests and
// the goldens, so what they exercise is the glue a node runs (design §4.2). Every call is a fresh
// instance over an in-memory filesystem.
import { createHash } from "node:crypto";
import {
  AbiError,
  decodeStageSpec,
  encodePlanInput,
  encodeRunInput,
  type FsManifest,
  LIMITS,
  type ParamTable,
  type StageSpec,
  type TaskLimits,
} from "@tabframe/protocol";
import {
  type BlobReader,
  type MemoryLimits,
  runTask,
  validateModuleBytes,
} from "@tabframe/sandbox";

/** The caps a node applies: the control plane's defaults (core's DEFAULT_TASK_LIMITS). */
export const HOST_LIMITS: TaskLimits = {
  maxOutputBytes: LIMITS.maxOutputBytes,
  maxWriteBytes: LIMITS.maxWriteBytes,
  maxWriteFiles: LIMITS.maxWriteFiles,
  maxLogBytes: LIMITS.maxLogBytes,
  // The machine's cap on a module's declared maximum; shipped programs declare the SDK's 256.
  memoryPagesMax: 1024,
};

export interface HostOptions {
  /** Path → bytes visible to `stat`, `read`, and `list`. */
  files?: Map<string, Uint8Array>;
  limits?: TaskLimits;
}

/** A program under the host. Each call runs in a fresh instance, as on a node. */
export interface ProgramInstance {
  plan(stage: number, params: ParamTable, hints?: ParamTable): StageSpec;
  /** What `plan` returned, before decoding. */
  planBytes(stage: number, params: ParamTable, hints?: ParamTable): Uint8Array;
  run(stage: number, taskIndex: number, taskCount: number, input: Uint8Array): Uint8Array;
  /** Every write of every call so far. */
  readonly writes: Map<string, Uint8Array>;
  /** One entry per call: that task's log as a node reports it. */
  readonly logs: string[];
}

/** A task failed — the sandbox's error text (`abort: …`, `trap: …`) — or a stage spec did not decode. */
export class ProgramError extends Error {}

/** sha-256 of some bytes, as hex. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const blobHashes = new WeakMap<Uint8Array, string>();

/** A manifest and a reader over path → bytes, content-addressed the way the store is. */
export function memoryFs(files: Map<string, Uint8Array>): {
  manifest: FsManifest;
  reader: BlobReader;
} {
  const blobs = new Map<string, Uint8Array>();
  const manifest: FsManifest = { version: 1, files: {} };
  for (const [path, bytes] of files) {
    let hash = blobHashes.get(bytes);
    if (hash === undefined) {
      hash = sha256Hex(bytes);
      blobHashes.set(bytes, hash);
    }
    blobs.set(hash, bytes);
    manifest.files[path] = { hash, size: bytes.length };
  }
  const reader: BlobReader = {
    read(hash, offset, len) {
      const whole = blobs.get(hash);
      if (!whole) return null;
      if (offset >= whole.length) return new Uint8Array(0);
      const end = Number.isFinite(len) ? Math.min(whole.length, offset + len) : whole.length;
      return whole.subarray(offset, end);
    },
  };
  return { manifest, reader };
}

/** Wrap a validated module: `plan` and `run` through the ABI, each in a fresh sandbox instance. */
export function instantiate(module: WebAssembly.Module, opts: HostOptions = {}): ProgramInstance {
  const { manifest, reader } = memoryFs(opts.files ?? new Map());
  const limits = opts.limits ?? HOST_LIMITS;
  const writes = new Map<string, Uint8Array>();
  const logs: string[] = [];

  const call = (kind: "run" | "plan", input: Uint8Array): Uint8Array => {
    const r = runTask(module, { kind, input, manifest, limits, reader });
    logs.push(r.log);
    if (!r.ok) throw new ProgramError(r.error);
    for (const [p, b] of r.writes) writes.set(p, b);
    return r.output;
  };
  const planBytes = (stage: number, params: ParamTable, hints: ParamTable = {}): Uint8Array =>
    call("plan", encodePlanInput({ stage, params, hints }));

  return {
    writes,
    logs,
    planBytes,
    plan(stage, params, hints = {}) {
      const out = planBytes(stage, params, hints);
      try {
        return decodeStageSpec(out);
      } catch (err) {
        if (err instanceof AbiError) throw new ProgramError(`invalid stage spec: ${err.message}`);
        throw err;
      }
    },
    run(stage, taskIndex, taskCount, input) {
      return call("run", encodeRunInput({ stage, taskIndex, taskCount, input }));
    },
  };
}

export interface StagedStage {
  name: string;
  taskCount: number;
  outputs: Uint8Array[];
  /** sha-256 hex of each task output, by task index. */
  hashes: string[];
  /** Each task's log, by task index. */
  logs: string[];
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
 * plan each stage, run its tasks against the filesystem as of the stage start, land outputs at
 * `/out/<stage>/<task>`, fold writes (two tasks writing different bytes to one path is a program
 * bug), and stop at `done`. Goldens and tests compare against this.
 */
export function runStaged(
  module: WebAssembly.Module,
  inputs: Map<string, Uint8Array>,
  params: ParamTable,
  opts: { hints?: ParamTable; maxStages?: number } = {},
): StagedRun {
  let files = new Map(inputs);
  const stages: StagedStage[] = [];
  const maxStages = opts.maxStages ?? 16;
  for (let s = 0; s < maxStages; s++) {
    const planner = instantiate(module, { files });
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
    const logs: string[] = [];
    const written = new Map<string, Uint8Array>();
    for (let i = 0; i < spec.tasks.length; i++) {
      const task = spec.tasks[i] as (typeof spec.tasks)[number];
      const inst = instantiate(module, { files });
      const out = inst.run(s, i, spec.tasks.length, task.input);
      outputs.push(out);
      hashes.push(sha256Hex(out));
      logs.push(inst.logs[0] ?? "");
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

/** Validate the way a node does (size, memory, imports, exports) and compile once. */
export function loadProgram(
  wasm: Uint8Array,
  limits: TaskLimits = HOST_LIMITS,
): { module: WebAssembly.Module; imports: string[]; exports: string[]; memory: MemoryLimits } {
  const v = validateModuleBytes(wasm, limits);
  if (!v.ok) throw new ProgramError(v.reason);
  const module = v.module as WebAssembly.Module;
  return {
    module,
    imports: WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`),
    exports: WebAssembly.Module.exports(module).map((e) => e.name),
    memory: v.memory,
  };
}
