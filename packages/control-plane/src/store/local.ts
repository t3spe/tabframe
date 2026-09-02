import { createHash } from "node:crypto";
import type { Store } from "@tabframe/core";

/**
 * The local store: content-addressed bytes in memory, served from the process itself.
 * Production uses S3 behind CloudFront (design §7.1); this keeps the same contract — the store
 * computes the hash and refuses bytes under any other name.
 */
export class LocalStore implements Store {
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly base: string;

  constructor(base: string) {
    this.base = base;
  }

  static hash(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
  }

  async put(bytes: Uint8Array): Promise<string> {
    const hash = LocalStore.hash(bytes);
    if (!this.blobs.has(hash)) this.blobs.set(hash, bytes);
    return hash;
  }

  /** Store under a caller-supplied hash only if the bytes really hash to it. */
  putVerified(
    hash: string,
    bytes: Uint8Array,
  ): { ok: true; size: number } | { ok: false; actual: string } {
    const actual = LocalStore.hash(bytes);
    if (actual !== hash) return { ok: false, actual };
    if (!this.blobs.has(hash)) this.blobs.set(hash, bytes);
    return { ok: true, size: bytes.length };
  }

  get(hash: string): Uint8Array | undefined {
    return this.blobs.get(hash);
  }

  has(hash: string): boolean {
    return this.blobs.has(hash);
  }

  url(hash: string): string {
    return `${this.base}/${hash}`;
  }

  get size(): number {
    return this.blobs.size;
  }
}

export const HASH_RE = /^[0-9a-f]{64}$/;

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
