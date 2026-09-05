// Blobs the panels show, fetched by hash once each: a render reads what has landed and a landing
// asks for a render.
import type { BlobSource } from "./tiles.ts";

/** Bytes kept: a dashboard open all day must not grow without bound. */
export const BLOB_CACHE_BYTES = 64 * 1024 * 1024;
/** A blob the store did not have, or a fetch that threw, is left alone this long before it is asked for again. */
export const MISSING_RETRY_MS = 10_000;

export type Cached = Uint8Array | null | "pending" | "error";

export interface BlobCacheDeps {
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => void;
  budgetBytes?: number;
}

export class BlobCache {
  private readonly got = new Map<string, Cached>();
  private readonly missingAt = new Map<string, number>();
  private readonly source: () => BlobSource;
  private readonly onChange: () => void;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => void;
  private readonly budget: number;
  private bytes = 0;
  private retryPending = false;
  /** Bumped when a fetch lands or fails, so a panel's signature changes with it; a miss bumps nothing. */
  version = 0;

  constructor(source: () => BlobSource, onChange: () => void, deps: BlobCacheDeps = {}) {
    this.source = source;
    this.onChange = onChange;
    this.now = deps.now ?? Date.now;
    this.schedule = deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
    this.budget = deps.budgetBytes ?? BLOB_CACHE_BYTES;
  }

  get(hash: string): Cached {
    const known = this.got.get(hash);
    const erroredAt = known === "error" ? this.missingAt.get(hash) : undefined;
    if (erroredAt !== undefined && this.now() - erroredAt >= MISSING_RETRY_MS) {
      this.got.delete(hash);
    } else if (known !== undefined) {
      // Re-inserted at the young end: eviction walks from the old one.
      this.got.delete(hash);
      this.got.set(hash, known);
      return known;
    }
    const missing = this.missingAt.get(hash);
    if (missing !== undefined && this.now() - missing < MISSING_RETRY_MS) return "pending";
    this.got.set(hash, "pending");
    void this.source()
      .get(hash)
      .then((bytes) => {
        if (bytes === null) {
          this.got.delete(hash);
          this.missingAt.set(hash, this.now());
          // A held page renders nothing on its own: the retry schedules the render that asks again.
          this.scheduleRetry();
        } else {
          this.missingAt.delete(hash);
          this.got.set(hash, bytes);
          this.bytes += bytes.length;
          this.evict();
          this.version += 1;
          this.onChange();
        }
      })
      .catch(() => {
        this.got.set(hash, "error");
        this.missingAt.set(hash, this.now());
        this.scheduleRetry();
        this.version += 1;
        this.onChange();
      });
    return "pending";
  }

  private scheduleRetry(): void {
    if (this.retryPending) return;
    this.retryPending = true;
    this.schedule(() => {
      this.retryPending = false;
      this.version += 1;
      this.onChange();
    }, MISSING_RETRY_MS + 50);
  }

  /** Drop the least recently used blobs until the cache fits its budget. */
  private evict(): void {
    for (const [hash, value] of this.got) {
      if (this.bytes <= this.budget) return;
      if (value === "pending" || value === "error" || value === null) continue;
      this.got.delete(hash);
      this.bytes -= value.length;
    }
  }
}
