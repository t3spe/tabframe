// Seeding (design §5.6, §9.3): the demo programs shipped in the image (or built in the repo) go
// into the store on first adopt, each as a bundle — a manifest blob naming the module, the
// program manifest, and any inputs — so a seeded program launches exactly like an uploaded one.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DEFAULT_TASK_LIMITS } from "@tabframe/core";
import {
  BUNDLE_PATHS,
  canonicalStringify,
  type FsManifest,
  type ProgramManifest,
  programManifest,
} from "@tabframe/protocol";
import { validateModuleBytes } from "@tabframe/sandbox";
import type { StoreDriver } from "@tabframe/store";

export interface DiscoveredProgram {
  name: string;
  dir: string;
  wasm: Uint8Array;
  manifestBytes: Uint8Array;
  manifest: ProgramManifest;
  /** Files under `in/`, as `/in/<file>`. */
  inputs: Array<{ path: string; bytes: Uint8Array }>;
}

export interface SeededProgram {
  name: string;
  bundle: string;
  module: string;
  manifest: ProgramManifest;
  files: FsManifest["files"];
}

/**
 * Find programs under a directory: `<dir>/<name>/program.wasm` (the image layout) or
 * `<dir>/<name>/dist/program.wasm` (the repo layout), with `manifest.json` beside the module.
 * Directories without a module are skipped; a bad manifest is an error naming the program.
 */
export function discoverPrograms(dir: string): DiscoveredProgram[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const found: DiscoveredProgram[] = [];
  for (const name of readdirSync(dir).sort()) {
    const base = path.join(dir, name);
    if (!statSync(base).isDirectory()) continue;
    const home = [base, path.join(base, "dist")].find((d) =>
      existsSync(path.join(d, "program.wasm")),
    );
    if (!home) continue;
    const manifestPath = path.join(home, "manifest.json");
    if (!existsSync(manifestPath)) throw new Error(`program ${name}: manifest.json is missing`);
    const manifestBytes = new Uint8Array(readFileSync(manifestPath));
    const manifest = programManifest.parse(JSON.parse(new TextDecoder().decode(manifestBytes)));
    const inputs: DiscoveredProgram["inputs"] = [];
    const inDir = [path.join(home, "in"), path.join(base, "in")].find((d) => existsSync(d));
    if (inDir) {
      for (const f of readdirSync(inDir).sort()) {
        const p = path.join(inDir, f);
        if (statSync(p).isFile())
          inputs.push({
            path: `${BUNDLE_PATHS.inputs}${f}`,
            bytes: new Uint8Array(readFileSync(p)),
          });
      }
    }
    found.push({
      name,
      dir: home,
      wasm: new Uint8Array(readFileSync(path.join(home, "program.wasm"))),
      manifestBytes,
      manifest,
      inputs,
    });
  }
  return found;
}

/**
 * Put each program's blobs into the store and return what the ledger needs. Modules are validated
 * the way an upload is (imports, exports, size, memory maximum); an invalid one is reported and
 * skipped, never seeded.
 */
export async function seedPrograms(
  store: StoreDriver,
  programs: DiscoveredProgram[],
  memoryPagesMax = DEFAULT_TASK_LIMITS.memoryPagesMax,
): Promise<{ seeded: SeededProgram[]; rejected: Array<{ name: string; reason: string }> }> {
  const seeded: SeededProgram[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];
  for (const p of programs) {
    const check = validateModuleBytes(p.wasm, { memoryPagesMax });
    if (!check.ok) {
      rejected.push({ name: p.name, reason: check.reason });
      continue;
    }
    const module = await store.put(p.wasm);
    const manifestHash = await store.put(p.manifestBytes);
    const files: FsManifest["files"] = {
      [BUNDLE_PATHS.module]: { hash: module, size: p.wasm.length },
      [BUNDLE_PATHS.manifest]: { hash: manifestHash, size: p.manifestBytes.length },
    };
    for (const input of p.inputs) {
      files[input.path] = { hash: await store.put(input.bytes), size: input.bytes.length };
    }
    const bundleManifest: FsManifest = { version: 1, files };
    const bundle = await store.put(new TextEncoder().encode(canonicalStringify(bundleManifest)));
    seeded.push({ name: p.name, bundle, module, manifest: p.manifest, files });
  }
  return { seeded, rejected };
}
