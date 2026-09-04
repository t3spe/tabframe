import type { PresignedUpload, PresignItem, StoreDriver } from "./driver.ts";
import { BlobTooLarge } from "./driver.ts";
import { HASH_RE, sha256Hex } from "./hash.ts";

/**
 * The local store: content-addressed bytes in memory, served from the control-plane process
 * itself. Same contract as S3 behind CloudFront — the store computes the hash and refuses bytes
 * under any other name — so nodes and pages have one client flow everywhere.
 */
export class LocalStore implements StoreDriver {
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly base: string;

  /** @param base the public URL prefix that serves `GET|PUT <base>/<hash>` */
  constructor(base: string) {
    this.base = base;
  }

  urlFor(hash: string): string {
    return `${this.base}/${hash}`;
  }

  async presign(items: PresignItem[]): Promise<PresignedUpload[]> {
    return items.map((it) => ({
      hash: it.hash,
      url: this.blobs.has(it.hash) ? null : this.urlFor(it.hash),
      headers: { "content-type": "application/octet-stream" },
    }));
  }

  async exists(hash: string): Promise<boolean> {
    return this.blobs.has(hash);
  }

  async get(hash: string, maxBytes?: number): Promise<Uint8Array | null> {
    const bytes = this.blobs.get(hash) ?? null;
    if (bytes && maxBytes !== undefined && bytes.length > maxBytes)
      throw new BlobTooLarge(hash, bytes.length, maxBytes);
    return bytes;
  }

  async put(bytes: Uint8Array): Promise<string> {
    const hash = await sha256Hex(bytes);
    if (!this.blobs.has(hash)) this.blobs.set(hash, bytes);
    return hash;
  }

  /** Store under a caller-supplied hash only if the bytes really hash to it (the PUT route). */
  async putVerified(
    hash: string,
    bytes: Uint8Array,
  ): Promise<{ ok: true; size: number } | { ok: false; actual: string }> {
    const actual = await sha256Hex(bytes);
    if (actual !== hash) return { ok: false, actual };
    if (!this.blobs.has(hash)) this.blobs.set(hash, bytes);
    return { ok: true, size: bytes.length };
  }

  getSync(hash: string): Uint8Array | undefined {
    return this.blobs.get(hash);
  }

  get size(): number {
    return this.blobs.size;
  }
}

export { HASH_RE };

/** Parse a single `bytes=a-b` range header against a length; undefined means "not a range". */
export function parseRange(
  header: string | undefined,
  length: number,
): { start: number; end: number } | null | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  let start = a === "" ? Math.max(0, length - Number(b)) : Number(a);
  let end = b === "" || a === "" ? length - 1 : Math.min(Number(b), length - 1);
  if (a === "") end = length - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= length) return null;
  start = Math.max(0, start);
  return { start, end };
}
