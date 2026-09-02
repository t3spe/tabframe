// The simulation's store: content-addressed bytes in memory, hashed the way the real store hashes
// (SHA-256 hex). A put returns the hash the store vouches for, which is what a presigned PUT pinned
// by checksum gives the real system: a node cannot claim a hash the store does not hold.
import { createHash } from "node:crypto";
import { canonicalStringify } from "@tabframe/protocol";
import type { BlobReader } from "@tabframe/sandbox";

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const encoder = new TextEncoder();

export class FakeStore implements BlobReader {
  private readonly blobs = new Map<string, Uint8Array>();
  puts = 0;
  reads = 0;

  put(bytes: Uint8Array): string {
    const hash = sha256(bytes);
    if (!this.blobs.has(hash)) this.blobs.set(hash, bytes.slice());
    this.puts += 1;
    return hash;
  }

  putJson(value: unknown): string {
    return this.put(encoder.encode(canonicalStringify(value)));
  }

  has(hash: string): boolean {
    return this.blobs.has(hash);
  }

  get(hash: string): Uint8Array | null {
    const bytes = this.blobs.get(hash);
    return bytes ? bytes.slice() : null;
  }

  get size(): number {
    return this.blobs.size;
  }

  /** The sandbox's synchronous read: a range of a blob, or null when the store lacks it. */
  read(hash: string, offset: number, len: number): Uint8Array | null {
    const whole = this.blobs.get(hash);
    if (!whole) return null;
    this.reads += 1;
    if (offset >= whole.length) return new Uint8Array(0);
    const end = Number.isFinite(len) ? Math.min(whole.length, offset + len) : whole.length;
    return whole.slice(offset, end);
  }
}
