// A built program from programs/<name>/dist, validated the way a node validates it, seeded into
// the fake store as a bundle, and run through the real sandbox. Task computations are memoized
// per process: the bytes of a task are a pure function of module, kind, input, and filesystem
// root, so twins, retries, and later seeds reuse them instead of paying the WebAssembly time again.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUNDLE_PATHS,
  type FsManifest,
  type ProgramManifest,
  programManifest,
  type TaskLimits,
} from "@tabframe/protocol";
import { type BlobReader, runTask, validateModuleBytes } from "@tabframe/sandbox";
import { DEFAULT_TASK_LIMITS } from "../src/ledger.ts";
import { type FakeStore, sha256 } from "./store.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** What `mise run goldens` writes: one hash per task of stage 0 from a single-node run. */
export interface Goldens {
  params: Record<string, unknown>;
  stageName: string;
  taskCount: number;
  hashes: string[];
}

export interface LoadedProgram {
  name: string;
  wasm: Uint8Array;
  module: WebAssembly.Module;
  moduleHash: string;
  manifest: ProgramManifest;
  goldens: Goldens | null;
}

export function loadProgram(name = "mandelbrot"): LoadedProgram {
  const dir = path.join(ROOT, "programs", name);
  let wasm: Uint8Array;
  try {
    wasm = new Uint8Array(readFileSync(path.join(dir, "dist", "program.wasm")));
  } catch {
    throw new Error(
      `programs/${name}/dist/program.wasm is missing; run \`mise run build:programs\``,
    );
  }
  const manifest = programManifest.parse(
    JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")),
  );
  const validation = validateModuleBytes(wasm, {
    memoryPagesMax: DEFAULT_TASK_LIMITS.memoryPagesMax,
  });
  if (!validation.ok) throw new Error(`program ${name}: ${validation.reason}`);
  let goldens: Goldens | null = null;
  try {
    goldens = JSON.parse(readFileSync(path.join(dir, "goldens.json"), "utf8")) as Goldens;
  } catch {
    goldens = null;
  }
  return { name, wasm, module: validation.module, moduleHash: sha256(wasm), manifest, goldens };
}

/** Put the bundle into the store the way seeding does: module, manifest, bundle manifest. */
export function seedProgram(
  store: FakeStore,
  program: LoadedProgram,
): { bundle: string; module: string; files: FsManifest["files"] } {
  const module = store.put(program.wasm);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(program.manifest));
  const manifestHash = store.put(manifestBytes);
  const files: FsManifest["files"] = {
    [BUNDLE_PATHS.module]: { hash: module, size: program.wasm.length },
    [BUNDLE_PATHS.manifest]: { hash: manifestHash, size: manifestBytes.length },
  };
  const bundleManifest: FsManifest = { version: 1, files };
  return { bundle: store.putJson(bundleManifest), module, files };
}

export type Computed =
  | { ok: true; output: Uint8Array; writes: Map<string, Uint8Array>; log: string }
  | { ok: false; error: string };

const cache = new Map<string, Computed>();
let misses = 0;

/** Run a task for real, once per distinct (module, kind, input, root). */
export function compute(
  program: LoadedProgram,
  kind: "run" | "plan",
  input: Uint8Array,
  fsRoot: string | null,
  manifest: FsManifest,
  reader: BlobReader,
  limits: TaskLimits,
): Computed {
  const key = `${program.moduleHash}:${kind}:${fsRoot ?? "-"}:${sha256(input)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  misses += 1;
  const r = runTask(program.module, { kind, input, manifest, limits, reader });
  const computed: Computed = r.ok
    ? { ok: true, output: r.output, writes: r.writes, log: r.log }
    : { ok: false, error: r.error };
  cache.set(key, computed);
  return computed;
}

export const computeCacheStats = () => ({ entries: cache.size, misses });
