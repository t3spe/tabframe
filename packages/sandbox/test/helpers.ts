import type { FsManifest, TaskLimits } from "@tabframe/protocol";
import type { BlobReader } from "../src/types.ts";

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export const H1 = "1".repeat(64);
export const H2 = "2".repeat(64);

export const limits: TaskLimits = {
  maxOutputBytes: 1 << 20,
  maxWriteBytes: 1 << 20,
  maxWriteFiles: 8,
  maxLogBytes: 64,
  memoryPagesMax: 256,
};

export const manifest: FsManifest = {
  version: 1,
  files: {
    "/in/a.txt": { hash: H1, size: 11 },
    "/in/b.txt": { hash: H2, size: 3 },
  },
};

export const blobs: Record<string, Uint8Array> = {
  [H1]: enc.encode("hello world"),
  [H2]: enc.encode("abc"),
};

/** A reader over the fixture blobs; counts calls so caching can be asserted. */
export class MapReader implements BlobReader {
  calls = 0;
  private readonly map: Record<string, Uint8Array>;
  constructor(map: Record<string, Uint8Array> = blobs) {
    this.map = map;
  }
  read(hash: string, offset: number, len: number): Uint8Array | null {
    this.calls++;
    const whole = this.map[hash];
    if (!whole) return null;
    const end = Number.isFinite(len) ? Math.min(whole.length, offset + len) : whole.length;
    return whole.slice(offset, end);
  }
}

/** Input for the fs fixture: a mode byte followed by an optional little-endian i32. */
export function modeInput(mode: number, n?: number): Uint8Array {
  if (n === undefined) return new Uint8Array([mode]);
  const out = new Uint8Array(5);
  out[0] = mode;
  new DataView(out.buffer).setInt32(1, n, true);
  return out;
}
