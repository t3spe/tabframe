// Compiles the AssemblyScript fixtures at test time with the pinned compiler, in memory, cached
// per process. The flags here are the ones the SDK build must use (see the WP doc).
import { readFileSync } from "node:fs";
import path from "node:path";
import asc from "assemblyscript/asc";

const here = path.dirname(new URL(import.meta.url).pathname);
/** Compiled bytes sit on a plain ArrayBuffer, which is what the WebAssembly API wants. */
export type WasmBytes = Uint8Array<ArrayBuffer>;

const cache = new Map<string, WasmBytes>();

export interface CompileOptions {
  /** Declared memory maximum in 64 KiB pages; omit to leave the maximum undeclared. */
  maximumMemory?: number;
  /** Extra asc flags. */
  flags?: string[];
}

export async function compileFixture(name: string, opts: CompileOptions = {}): Promise<WasmBytes> {
  const key = `${name}:${opts.maximumMemory ?? "none"}:${(opts.flags ?? []).join(" ")}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const source = readFileSync(path.join(here, "assembly", `${name}.ts`), "utf8");
  const files: Record<string, string> = { [`${name}.ts`]: source };
  const out: Record<string, WasmBytes> = {};
  const argv = [`${name}.ts`, "--outFile", "out.wasm", "--runtime", "stub", "--optimizeLevel", "0"];
  if (opts.maximumMemory !== undefined) argv.push("--maximumMemory", String(opts.maximumMemory));
  argv.push(...(opts.flags ?? []));
  const { error, stderr } = await asc.main(argv, {
    readFile: (file) => files[file] ?? null,
    writeFile: (file, data) => {
      out[file] = data as WasmBytes;
    },
    listFiles: () => [],
  });
  if (error)
    throw new Error(`asc failed for ${name}: ${error.message}\n${stderr?.toString() ?? ""}`);
  const bytes = out["out.wasm"];
  if (!bytes) throw new Error(`asc produced no output for ${name}`);
  cache.set(key, bytes);
  return bytes;
}
