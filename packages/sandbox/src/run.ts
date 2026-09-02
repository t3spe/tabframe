import { FsView, RC } from "./fs.ts";
import type { TaskRequest, TaskResult } from "./types.ts";

/** A program called abort: the message, when AssemblyScript gave one, is the task's error. */
export class SandboxAbort extends Error {}

const utf8 = new TextDecoder("utf-8", { fatal: false });
const utf16 = new TextDecoder("utf-16le");
const encoder = new TextEncoder();

type Fn = (...args: number[]) => number;

/**
 * Run one task in a fresh instance of a validated module (design §4.2). The imports are bound to
 * a FsView for this task alone; the instance is discarded afterwards, so nothing leaks between
 * tasks or programs. Synchronous by design: the reader supplies bytes without awaiting.
 */
export function runTask(module: WebAssembly.Module, req: TaskRequest): TaskResult {
  const fs = new FsView(req.manifest, req.reader, req.limits);
  let memory: WebAssembly.Memory | null = null;
  const buf = (): Uint8Array => new Uint8Array((memory as WebAssembly.Memory).buffer);
  const inBounds = (ptr: number, len: number): boolean =>
    len >= 0 && ptr >= 0 && ptr + len <= (memory as WebAssembly.Memory).buffer.byteLength;
  const str = (ptr: number, len: number): string | null =>
    inBounds(ptr, len) ? utf8.decode(buf().subarray(ptr, ptr + len)) : null;

  const imports: WebAssembly.Imports = {
    tf: {
      stat: (pathPtr: number, pathLen: number): bigint => {
        const path = str(pathPtr, pathLen);
        return BigInt(path === null ? RC.badArgs : fs.stat(path));
      },
      read: (pathPtr: number, pathLen: number, offset: number, dst: number, dstLen: number) => {
        const path = str(pathPtr, pathLen);
        if (path === null || !inBounds(dst, dstLen)) return RC.badArgs;
        const r = fs.read(path, offset, dstLen);
        if (typeof r === "number") return r;
        buf().set(r, dst);
        return r.length;
      },
      write: (pathPtr: number, pathLen: number, src: number, srcLen: number): number => {
        const path = str(pathPtr, pathLen);
        if (path === null || !inBounds(src, srcLen)) return RC.badArgs;
        return fs.write(path, buf().slice(src, src + srcLen));
      },
      list: (prefixPtr: number, prefixLen: number, dst: number, dstLen: number): number => {
        const prefix = str(prefixPtr, prefixLen);
        if (prefix === null || !inBounds(dst, dstLen)) return RC.badArgs;
        const listing = encoder.encode(fs.list(prefix));
        if (listing.length <= dstLen) buf().set(listing, dst);
        return listing.length;
      },
      log: (src: number, srcLen: number): void => {
        const text = str(src, srcLen);
        if (text !== null) fs.appendLog(text);
      },
    },
    env: {
      abort: (msgPtr: number, filePtr: number, line: number, col: number): void => {
        const message = asString(memory, msgPtr);
        const file = asString(memory, filePtr);
        throw new SandboxAbort(`${message || "abort"}${file ? ` (${file}:${line}:${col})` : ""}`);
      },
    },
  };

  const started = performance.now();
  try {
    const instance = new WebAssembly.Instance(module, imports);
    const exp = instance.exports;
    if (!(exp.memory instanceof WebAssembly.Memory)) return fail("missing export memory", fs);
    memory = exp.memory;
    const alloc = exp.alloc as Fn;
    const entry = exp[req.kind] as Fn;
    if (typeof alloc !== "function" || typeof entry !== "function") {
      return fail(`missing export ${req.kind}`, fs);
    }

    const inLen = req.input.length;
    const inPtr = inLen === 0 ? 0 : alloc(inLen) >>> 0;
    if (inLen > 0) {
      if (!inBounds(inPtr, inLen)) return fail("alloc returned an out-of-bounds pointer", fs);
      buf().set(req.input, inPtr);
    }
    const retPtr = entry(inPtr, inLen) >>> 0;
    if (!inBounds(retPtr, 8)) return fail("entry returned an out-of-bounds pair pointer", fs);
    const view = new DataView(memory.buffer);
    const outPtr = view.getUint32(retPtr, true);
    const outLen = view.getUint32(retPtr + 4, true);
    if (outLen > req.limits.maxOutputBytes) {
      return fail(`output is ${outLen} bytes, cap ${req.limits.maxOutputBytes}`, fs);
    }
    if (!inBounds(outPtr, outLen)) return fail("output pair points outside memory", fs);
    const output = buf().slice(outPtr, outPtr + outLen);
    return {
      ok: true,
      output,
      writes: fs.writes,
      log: fs.log,
      computeMs: performance.now() - started,
    };
  } catch (err) {
    if (err instanceof SandboxAbort) return fail(`abort: ${err.message}`, fs);
    if (err instanceof WebAssembly.RuntimeError) return fail(`trap: ${err.message}`, fs);
    if (err instanceof WebAssembly.LinkError) return fail(`link: ${err.message}`, fs);
    return fail(`error: ${err instanceof Error ? err.message : String(err)}`, fs);
  }
}

function fail(error: string, fs: FsView): TaskResult {
  return { ok: false, error, log: fs.log };
}

/** AssemblyScript strings are UTF-16LE with their byte length four bytes before the data. */
function asString(memory: WebAssembly.Memory | null, ptr: number): string {
  if (!memory || ptr < 4) return "";
  const bytes = new Uint8Array(memory.buffer);
  if (ptr + 4 > bytes.length) return "";
  const len = new DataView(memory.buffer).getUint32(ptr - 4, true);
  if (len > 4096 || ptr + len > bytes.length) return "";
  return utf16.decode(bytes.subarray(ptr, ptr + len));
}
