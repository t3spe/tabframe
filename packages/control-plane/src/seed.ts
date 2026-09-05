// Seeding (design §5.6, §9.3): the demo programs shipped in the image (or built in the repo) go
// into the store on first adopt, each as a bundle — a manifest blob naming the module, the
// program manifest, and any inputs — so a seeded program launches exactly like an uploaded one.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DEFAULT_TASK_LIMITS, type Event, type Ledger } from "@tabframe/core";
import {
  BUNDLE_PATHS,
  canonicalStringify,
  type FsManifest,
  type ProgramManifest,
  programManifest,
} from "@tabframe/protocol";
import { validateModuleBytes } from "@tabframe/sandbox";
import type { StoreDriver } from "@tabframe/store";

/** An unshipped program nobody has run in the ledger's memory is retired at seeding after this long. */
export const STALE_DROP_MS = 60 * 60 * 1000;

export interface DiscoveredProgram {
  name: string;
  dir: string;
  wasm: Uint8Array;
  manifestBytes: Uint8Array;
  manifest: ProgramManifest;
  /** Files under `in/`, as `/in/<file>`. */
  inputs: Array<{ path: string; bytes: Uint8Array }>;
  /** The program's source (`assembly/index.ts` in the repo, `source.ts` in the image), when present. */
  source?: Uint8Array;
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
    const sourcePath = [path.join(base, "assembly", "index.ts"), path.join(home, "source.ts")].find(
      (f) => existsSync(f),
    );
    found.push({
      name,
      dir: home,
      wasm: new Uint8Array(readFileSync(path.join(home, "program.wasm"))),
      manifestBytes,
      manifest,
      inputs,
      ...(sourcePath ? { source: new Uint8Array(readFileSync(sourcePath)) } : {}),
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
    // The source goes into the store and the manifest names it, so the editor can open the
    // shipped program the way it opens an upload; the manifest blob is re-serialised with the hash.
    let manifest = p.manifest;
    let manifestBytes = p.manifestBytes;
    if (p.source) {
      manifest = { ...p.manifest, source: await store.put(p.source) };
      manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    }
    const manifestHash = await store.put(manifestBytes);
    const files: FsManifest["files"] = {
      [BUNDLE_PATHS.module]: { hash: module, size: p.wasm.length },
      [BUNDLE_PATHS.manifest]: { hash: manifestHash, size: manifestBytes.length },
    };
    for (const input of p.inputs) {
      files[input.path] = { hash: await store.put(input.bytes), size: input.bytes.length };
    }
    const bundleManifest: FsManifest = { version: 1, files };
    const bundle = await store.put(new TextEncoder().encode(canonicalStringify(bundleManifest)));
    seeded.push({ name: p.name, bundle, module, manifest, files });
  }
  return { seeded, rejected };
}

export interface SeedReport {
  programs: Array<{ name: string; bundle: string }>;
  added: string[];
  retired: string[];
  stale: string[];
  defaultLoop: string | null;
  loopMoved: boolean;
}

/**
 * What seeding changes in a ledger, decided without touching it. Seeding is by bundle hash, not
 * "have we ever seeded": a deploy that ships a new program has to reach a machine that keeps
 * adopting its predecessor's ledger, and a bundle already in the ledger is left alone.
 */
export function reconcileSeed(
  target: Ledger,
  seeded: SeededProgram[],
  opts: { defaultProgram: string; now: number; staleAfterMs?: number },
): { events: Event[]; report: SeedReport } {
  const staleAfterMs = opts.staleAfterMs ?? STALE_DROP_MS;
  const events: Event[] = [];
  const added = seeded.filter((p) => !target.programs.has(p.bundle));
  for (const p of added) {
    events.push({
      kind: "programAdded",
      bundle: p.bundle,
      module: p.module,
      manifest: p.manifest,
      files: p.files,
    });
  }
  // The image owns the names it ships: a record under a shipped name with another bundle is the
  // previous deploy's version (or a drop that borrowed the name) and is retired, so the list
  // shows one `mandelbrot` and the old one's follow-up chain ends.
  const shipped = new Set(seeded.map((p) => p.bundle));
  const names = new Set(seeded.map((p) => p.name));
  const live = [...target.programs.values()].filter((p) => !p.retired && !shipped.has(p.bundle));
  const retired = live.filter((p) => names.has(p.manifest.name));
  // Drops stay as long as they are used: an unshipped program that no remaining execution refers
  // to (the ledger keeps the last 32) and that is over an hour old is retired too, so runbook
  // uploads and abandoned experiments do not clutter the list for ever.
  const referenced = new Set([...target.executions.values()].map((e) => e.bundle));
  const stale = live.filter(
    (p) =>
      !names.has(p.manifest.name) &&
      !referenced.has(p.bundle) &&
      opts.now - p.addedAt > staleAfterMs,
  );
  const retiring = new Set([...retired, ...stale].map((p) => p.bundle));
  for (const bundle of retiring) events.push({ kind: "programRetired", bundle });
  // The machine's own loop follows the shipped program: set when there is none, moved when the
  // one it points at is gone, retired, or about to be.
  const loop = seeded.find((p) => p.name === opts.defaultProgram) ?? seeded[0] ?? null;
  const current = target.config.defaultLoop;
  const currentProgram = current ? target.programs.get(current.bundle) : undefined;
  const moved =
    loop !== null &&
    (!current ||
      !currentProgram ||
      currentProgram.retired === true ||
      retiring.has(currentProgram.bundle));
  if (loop && moved) {
    events.push({
      kind: "setDefaultLoop",
      loop: { bundle: loop.bundle, params: loop.manifest.defaultParams },
    });
  }
  const short = (p: { manifest: ProgramManifest; bundle: string }) =>
    `${p.manifest.name}@${p.bundle.slice(0, 12)}`;
  return {
    events,
    report: {
      programs: seeded.map((p) => ({ name: p.name, bundle: p.bundle.slice(0, 12) })),
      added: added.map((p) => p.name),
      retired: retired.map(short),
      stale: stale.map(short),
      defaultLoop: loop?.name ?? null,
      loopMoved: moved,
    },
  };
}
