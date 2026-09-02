// The AssemblyScript compiler over an in-memory filesystem (design §5.6). Imported only by the
// compiler worker and the tests: asc is 1.6 MB before binaryen, and the dashboard must not pay
// for it. The same function runs under Node in the tests that check a page compile is
// byte-identical to the build's.
import type { DiagnosticMessage } from "assemblyscript";
import asc from "assemblyscript/asc";
// Types only: the worker bundle must not drag the protocol schemas or the sandbox along.
import type { CompileResult, Diagnostic, DiagnosticLevel, VirtualFs } from "./editor-core.ts";

const OUT = "program.wasm";

/** Normalize what asc asks for: strip `./` segments and join with the base directory. */
export function virtualPath(filename: string, baseDir: string): string {
  const joined =
    baseDir && baseDir !== "." && !filename.startsWith("/") ? `${baseDir}/${filename}` : filename;
  const parts: string[] = [];
  for (const seg of joined.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

const LEVELS: Record<number, DiagnosticLevel> = {
  0: "pedantic",
  1: "info",
  2: "warning",
  3: "error",
};

/**
 * asc hands the reporter a plain copy: code, category, message, and a range with byte offsets and
 * the source's normalized path — no line numbers. Those come from the virtual file itself.
 */
function toDiagnostic(d: DiagnosticMessage, fs: VirtualFs): Diagnostic {
  let file: string | null = null;
  let line: number | null = null;
  let column: number | null = null;
  if (d.range) {
    file = d.range.source.normalizedPath;
    const text = fs.files[file] ?? fs.files[`${file}.ts`];
    if (text !== undefined) {
      const pos = lineColumn(text, d.range.start);
      line = pos.line;
      column = pos.column;
    }
  }
  return {
    level: LEVELS[d.category] ?? "error",
    code: d.code,
    message: d.message,
    file,
    line,
    column,
  };
}

/** 1-based line and column of a character offset in a text. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  const upTo = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lastBreak = upTo.lastIndexOf("\n");
  return { line: upTo.split("\n").length, column: upTo.length - lastBreak };
}

/**
 * Compile the virtual filesystem's entry with the SDK's flags. Every file asc opens comes from
 * the map; the output is captured instead of written. Never throws for a bad program: the
 * diagnostics carry the story and `ok` is false.
 */
export async function compileInMemory(fs: VirtualFs, flags: string[]): Promise<CompileResult> {
  const started = performance.now();
  const diagnostics: Diagnostic[] = [];
  let wasm: Uint8Array | null = null;
  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];
  const stream = (chunks: string[]) => ({
    write(chunk: Uint8Array | string) {
      chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    },
  });
  const args = [fs.entry, "--outFile", OUT, "--path", "node_modules", ...flags];
  let error: Error | null = null;
  try {
    const result = await asc.main(args, {
      stdout: stream(stdoutChunks) as never,
      stderr: stream(stderrChunks) as never,
      readFile: (filename, baseDir) => fs.files[virtualPath(filename, baseDir)] ?? null,
      writeFile: (filename, contents) => {
        if (virtualPath(filename, ".") === OUT && typeof contents !== "string") wasm = contents;
      },
      listFiles: (dirname, baseDir) => {
        const prefix = `${virtualPath(dirname, baseDir)}/`;
        const names = Object.keys(fs.files)
          .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
          .map((p) => p.slice(prefix.length));
        return names.length ? names : null;
      },
      reportDiagnostic: (d) => diagnostics.push(toDiagnostic(d as DiagnosticMessage, fs)),
    });
    error = result.error ?? null;
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
  }
  const ok = error === null && wasm !== null;
  if (!ok && error && !diagnostics.some((d) => d.level === "error")) {
    diagnostics.push({
      level: "error",
      code: 0,
      message: error.message,
      file: null,
      line: null,
      column: null,
    });
  }
  return {
    ok,
    wasm: ok ? wasm : null,
    diagnostics,
    stderr: stderrChunks.join(""),
    ms: Math.round(performance.now() - started),
  };
}

export const COMPILER_VERSION: string = asc.version;
