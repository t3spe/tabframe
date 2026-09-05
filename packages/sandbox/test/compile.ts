// Compiles the AssemblyScript fixtures at test time with the pinned compiler, in memory, cached
// per process — on the SDK's runtime and reference memory maximum, so a fixture is shaped like a
// shipped program; at -O0, because nothing here is timed.
import { readFileSync } from "node:fs";
import path from "node:path";
import asc from "assemblyscript/asc";
import { ASC_RUNTIME, MEMORY_PAGES_REFERENCE } from "../../sdk-as/flags.ts";

const here = path.dirname(new URL(import.meta.url).pathname);
/** Compiled bytes sit on a plain ArrayBuffer, which is what the WebAssembly API wants. */
export type WasmBytes = Uint8Array<ArrayBuffer>;

const cache = new Map<string, WasmBytes>();

export interface CompileOptions {
  /** Declared memory maximum in 64 KiB pages: the SDK's reference by default; null declares none. */
  maximumMemory?: number | null;
  /** Extra asc flags. */
  flags?: string[];
}

export async function compileFixture(name: string, opts: CompileOptions = {}): Promise<WasmBytes> {
  const max = opts.maximumMemory === undefined ? MEMORY_PAGES_REFERENCE : opts.maximumMemory;
  const key = `${name}:${max ?? "none"}:${(opts.flags ?? []).join(" ")}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const source = readFileSync(path.join(here, "assembly", `${name}.ts`), "utf8");
  const files: Record<string, string> = { [`${name}.ts`]: source };
  const out: Record<string, WasmBytes> = {};
  const argv = [`${name}.ts`, "--outFile", "out.wasm", ...ASC_RUNTIME, "--optimizeLevel", "0"];
  if (max !== null) argv.push("--maximumMemory", String(max));
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
