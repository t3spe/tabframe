// `mise run build:programs`: compile every programs/<name>/assembly/index.ts to
// programs/<name>/dist/program.wasm with the SDK's flags, and copy manifest.json next to it.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import asc from "assemblyscript/asc";
import { ASC_FLAGS } from "../flags.ts";

export { ASC_FLAGS } from "../flags.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const programsDir = path.join(root, "programs");

/** Compile one entry with the build's flags; `--path` lets asc find the SDK through the program's node_modules. */
export async function compileProgram(
  entry: string,
  outFile: string,
  extraFlags: string[] = [],
): Promise<void> {
  mkdirSync(path.dirname(outFile), { recursive: true });
  const programDir = path.resolve(path.dirname(entry), "..");
  const args = [
    entry,
    "--outFile",
    outFile,
    "--baseDir",
    root,
    "--path",
    path.join(programDir, "node_modules"),
    ...ASC_FLAGS,
    ...extraFlags,
  ];
  const { error, stderr } = await asc.main(args);
  if (error) throw new Error(`asc failed for ${path.relative(root, entry)}:\n${String(stderr)}`);
}

export async function buildAll(): Promise<string[]> {
  const built: string[] = [];
  if (!existsSync(programsDir)) return built;
  for (const name of readdirSync(programsDir)) {
    const dir = path.join(programsDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const entry = path.join(dir, "assembly", "index.ts");
    if (!existsSync(entry)) continue;
    const dist = path.join(dir, "dist");
    await compileProgram(entry, path.join(dist, "program.wasm"));
    const manifest = path.join(dir, "manifest.json");
    if (existsSync(manifest)) copyFileSync(manifest, path.join(dist, "manifest.json"));
    built.push(name);
    console.log(
      `[build:programs] ${name} → ${path.relative(root, dist)}/program.wasm (${statSync(path.join(dist, "program.wasm")).size} bytes)`,
    );
  }
  return built;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = await buildAll();
  if (built.length === 0) console.log("[build:programs] nothing to build");
}
