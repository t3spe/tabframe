// Where the demo programs live and how the tests get a compiled one: a program is compiled into
// `packages/sdk-as/dist-test/<name>.wasm` only when that file is older than a program or SDK
// source. A stale module no longer matches its goldens; a fresh one is worth no compiler time.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ProgramManifest, programManifest } from "@tabframe/protocol";
import { compileProgram } from "./build-programs.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "../../..");
const SDK_ASSEMBLY = path.resolve(here, "../assembly");
/** Where test compiles land; not committed. */
export const DIST_TEST = path.resolve(here, "../dist-test");

export function programDir(name: string): string {
  return path.join(ROOT, "programs", name);
}

/** programs/<name>/manifest.json, validated. */
export function readManifest(name: string): ProgramManifest {
  const text = readFileSync(path.join(programDir(name), "manifest.json"), "utf8");
  return programManifest.parse(JSON.parse(text));
}

/** A program's bundle inputs as the control plane seeds them: programs/<name>/in/<file> → /in/<file>. */
export function inputsOf(name: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const inDir = path.join(programDir(name), "in");
  if (!existsSync(inDir)) return files;
  for (const f of readdirSync(inDir).sort()) {
    files.set(`/in/${f}`, new Uint8Array(readFileSync(path.join(inDir, f))));
  }
  return files;
}

/** programs/<name>/goldens.json, in the shape the caller expects. */
export function readGoldens<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(programDir(name), "goldens.json"), "utf8")) as T;
}

/** The module `mise run build:programs` wrote — what ships — or a clear error when it has not run. */
export function distModule(name: string): Uint8Array {
  const file = path.join(programDir(name), "dist", "program.wasm");
  if (!existsSync(file)) {
    throw new Error(`${path.relative(ROOT, file)} is missing; run \`mise run build:programs\``);
  }
  return new Uint8Array(readFileSync(file));
}

/** True when the file is missing or any .ts directly under one of the directories is newer. */
export function staleAgainst(file: string, sourceDirs: string[]): boolean {
  if (!existsSync(file)) return true;
  const builtAt = statSync(file).mtimeMs;
  return sourceDirs.some(
    (dir) =>
      existsSync(dir) &&
      readdirSync(dir).some(
        (f) => f.endsWith(".ts") && statSync(path.join(dir, f)).mtimeMs > builtAt,
      ),
  );
}

/** Compile `entry` to `outFile` with the build's flags unless the file is newer than its sources and the SDK's. */
export async function compileIfStale(entry: string, outFile: string): Promise<Uint8Array> {
  if (staleAgainst(outFile, [path.dirname(entry), SDK_ASSEMBLY])) {
    await compileProgram(entry, outFile);
  }
  return new Uint8Array(readFileSync(outFile));
}

/** programs/<name> compiled into dist-test when stale; the bytes either way. */
export function compiledProgram(name: string, outDir = DIST_TEST): Promise<Uint8Array> {
  const entry = path.join(programDir(name), "assembly", "index.ts");
  return compileIfStale(entry, path.join(outDir, `${name}.wasm`));
}
