// What passes between the editor, the compiler, and the worker that runs it. Types only: the worker
// bundle must not drag the editor along, and the editor must not depend on the worker's entry.

/** The files a compile sees, by path, with the entry to compile. */
export interface VirtualFs {
  entry: string;
  files: Record<string, string>;
}

export type DiagnosticLevel = "pedantic" | "info" | "warning" | "error";

export interface Diagnostic {
  level: DiagnosticLevel;
  code: number;
  message: string;
  file: string | null;
  line: number | null;
  column: number | null;
}

export interface CompileResult {
  ok: boolean;
  wasm: Uint8Array | null;
  diagnostics: Diagnostic[];
  stderr: string;
  ms: number;
}

export interface CompileRequest {
  type: "compile";
  id: number;
  fs: VirtualFs;
  flags: string[];
}
export type WorkerRequest = CompileRequest;
export type WorkerReply =
  | { type: "ready"; version: string }
  | ({ type: "compiled"; id: number } & CompileResult);
