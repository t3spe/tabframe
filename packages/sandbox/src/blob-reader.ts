import type { BlobReader } from "./types.ts";

/**
 * Per-node cache by hash (design §4.2): the first read of a hash fetches the whole blob once;
 * every later read, whatever the range, is served from memory. Evicts oldest-first past a byte cap.
 */
export class CachingBlobReader implements BlobReader {
  private readonly inner: BlobReader;
  private readonly cap: number;
  private readonly cache = new Map<string, Uint8Array>();
  private bytes = 0;

  constructor(inner: BlobReader, capBytes = 64 * 1024 * 1024) {
    this.inner = inner;
    this.cap = capBytes;
  }

  read(hash: string, offset: number, len: number): Uint8Array | null {
    let whole = this.cache.get(hash);
    if (!whole) {
      const fetched = this.inner.read(hash, 0, Number.POSITIVE_INFINITY);
      if (!fetched) return null;
      whole = fetched;
      this.cache.set(hash, whole);
      this.bytes += whole.length;
      for (const [k, v] of this.cache) {
        if (this.bytes <= this.cap) break;
        this.cache.delete(k);
        this.bytes -= v.length;
      }
    }
    if (offset >= whole.length) return new Uint8Array(0);
    const end = Number.isFinite(len) ? Math.min(whole.length, offset + len) : whole.length;
    return whole.slice(offset, end);
  }

  get size(): number {
    return this.cache.size;
  }
}
