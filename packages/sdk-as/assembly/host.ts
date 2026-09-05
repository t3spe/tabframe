// The five host imports (design §5.3) and their wrappers. These are the only imports a program may
// have besides `env.abort`; the sandbox rejects anything else. The `…Rc` forms return the host's
// raw code (see RC); the plain forms fold the codes into a bool or a null.

// @ts-ignore: decorator
@external("tf", "stat")
declare function tf_stat(path: usize, pathLen: i32): i64;
// @ts-ignore: decorator
@external("tf", "read")
declare function tf_read(path: usize, pathLen: i32, offset: i32, dst: usize, dstLen: i32): i32;
// @ts-ignore: decorator
@external("tf", "write")
declare function tf_write(path: usize, pathLen: i32, src: usize, srcLen: i32): i32;
// @ts-ignore: decorator
@external("tf", "list")
declare function tf_list(prefix: usize, prefixLen: i32, dst: usize, dstLen: i32): i32;
// @ts-ignore: decorator
@external("tf", "log")
declare function tf_log(src: usize, srcLen: i32): void;

/** Append to the task's log (shown in the dashboard's task detail; capped by the host). No separator is added. */
export function log(text: string): void {
  const encoded = String.UTF8.encode(text);
  tf_log(changetype<usize>(encoded), encoded.byteLength);
}

export namespace fs {
  /** File size in bytes, or RC.notFound. */
  export function stat(path: string): i64 {
    const p = String.UTF8.encode(path);
    return tf_stat(changetype<usize>(p), p.byteLength);
  }

  /** `read`'s raw result: bytes copied into `dst` (fewer at the end of the file), or a negative RC. */
  export function readRc(path: string, offset: i32, dst: Uint8Array): i32 {
    const p = String.UTF8.encode(path);
    return tf_read(changetype<usize>(p), p.byteLength, offset, dst.dataStart, dst.byteLength);
  }

  /** A byte range of a file, or null if the path does not exist. */
  export function readRange(path: string, offset: i32, len: i32): Uint8Array | null {
    const out = new Uint8Array(len);
    const got = readRc(path, offset, out);
    if (got < 0) return null;
    return got == len ? out : out.subarray(0, got);
  }

  /** The whole file, or null if the path does not exist. */
  export function read(path: string): Uint8Array | null {
    const size = stat(path);
    if (size < 0) return null;
    if (size == 0) return new Uint8Array(0);
    return readRange(path, 0, <i32>size);
  }

  /** The whole file, or abort: for an input the program cannot run without. */
  export function readOrAbort(path: string): Uint8Array {
    const bytes = read(path);
    if (bytes === null) abort("missing " + path);
    return bytes as Uint8Array;
  }

  /** `write`'s raw result: 0, or a negative RC (a bad path is not a spent budget). */
  export function writeRc(path: string, bytes: Uint8Array): i32 {
    const p = String.UTF8.encode(path);
    return tf_write(changetype<usize>(p), p.byteLength, bytes.dataStart, bytes.byteLength);
  }

  /** Replace the whole file; visible to the next stage once the task's result is accepted. */
  export function write(path: string, bytes: Uint8Array): bool {
    return writeRc(path, bytes) == 0;
  }

  /** Paths under a prefix. */
  export function list(prefix: string): string[] {
    const p = String.UTF8.encode(prefix);
    let cap = 4096;
    for (let attempt = 0; attempt < 8; attempt++) {
      const buf = new Uint8Array(cap);
      const need = tf_list(changetype<usize>(p), p.byteLength, buf.dataStart, cap);
      if (need < 0) return [];
      if (need <= cap) {
        if (need == 0) return [];
        const text = String.UTF8.decodeUnsafe(buf.dataStart, <usize>need);
        return text.split("\n");
      }
      cap = need;
    }
    return [];
  }

  /**
   * A finished stage's task outputs in task order: `/out/<stage>/<i>` for every i below the
   * listing's count. A missing index aborts: a stage's outputs are all there or the stage did not end.
   */
  export function outputs(stage: u32): Uint8Array[] {
    const prefix = "/out/" + stage.toString() + "/";
    const count = list(prefix).length;
    const out = new Array<Uint8Array>(count);
    for (let i = 0; i < count; i++) out[i] = readOrAbort(prefix + i.toString());
    return out;
  }
}
