// Test fixture: the demo programs compiled into a directory shaped like `/app/programs`.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { compileProgram } from "../../sdk-as/scripts/build-programs.ts";

export const ROOT = path.resolve(import.meta.dirname, "../../..");
export const PROGRAMS_DIR = path.join(ROOT, "packages/control-plane/dist-test/programs");

/** Compile Mandelbrot once per test run into `dist-test/programs/mandelbrot/`. */
export async function buildFixturePrograms(): Promise<string> {
  const src = path.join(ROOT, "programs/mandelbrot");
  const out = path.join(PROGRAMS_DIR, "mandelbrot");
  mkdirSync(out, { recursive: true });
  if (!existsSync(path.join(out, "program.wasm"))) {
    await compileProgram(path.join(src, "assembly/index.ts"), path.join(out, "program.wasm"));
  }
  copyFileSync(path.join(src, "manifest.json"), path.join(out, "manifest.json"));
  return PROGRAMS_DIR;
}

export function goldens(): {
  params: Record<string, unknown>;
  taskCount: number;
  hashes: string[];
} {
  return JSON.parse(readFileSync(path.join(ROOT, "programs/mandelbrot/goldens.json"), "utf8"));
}
