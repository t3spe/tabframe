import { LIMITS } from "@tabframe/protocol";
import type { PresignedUpload, PresignItem } from "./driver.ts";
import { sha256Hex } from "./hash.ts";

/** Presign is a socket message (D18); the node and the page provide the round trip. */
export interface PresignRequester {
  presign(items: PresignItem[]): Promise<PresignedUpload[]>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The one client flow everywhere (design §7.1): hash locally, ask for presigned URLs over the
 * socket, PUT straight to the store with the pinned headers, and read blobs by hash from the CDN.
 */
export class StoreClient {
  private readonly base: string;
  private readonly requester: PresignRequester;
  private readonly fetchImpl: FetchLike;

  constructor(
    base: string,
    requester: PresignRequester,
    fetchImpl: FetchLike = (u, i) => fetch(u, i),
  ) {
    this.base = base.replace(/\/$/, "");
    this.requester = requester;
    this.fetchImpl = fetchImpl;
  }

  urlFor(hash: string): string {
    return `${this.base}/${hash}`;
  }

  async put(bytes: Uint8Array): Promise<{ hash: string; size: number }> {
    const [r] = await this.putMany([bytes]);
    if (!r) throw new Error("unreachable");
    return r;
  }

  /** Upload many blobs, presigning in capped batches; blobs the store already has are skipped. */
  async putMany(blobs: Uint8Array[]): Promise<Array<{ hash: string; size: number }>> {
    const items = await Promise.all(
      blobs.map(async (b) => ({ hash: await sha256Hex(b), size: b.length, bytes: b })),
    );
    const unique = new Map<string, { hash: string; size: number; bytes: Uint8Array }>();
    for (const it of items) unique.set(it.hash, it);
    // Presigns go in batches of the protocol's cap (WP8.2), one round trip at a time: a frame of
    // 256 tiles is eleven small requests, not one the control plane refuses.
    const wanted = [...unique.values()].map(({ hash, size }) => ({ hash, size }));
    const byHash = new Map<string, PresignedUpload>();
    for (let i = 0; i < wanted.length; i += LIMITS.maxPresignItems) {
      const batch = await this.requester.presign(wanted.slice(i, i + LIMITS.maxPresignItems));
      for (const p of batch) byHash.set(p.hash, p);
    }
    await Promise.all(
      [...unique.values()].map(async (it) => {
        const p = byHash.get(it.hash);
        if (!p) throw new Error(`no presign for ${it.hash}`);
        if (p.url === null) return;
        // A transient failure is retried a few times (WP8.1): one S3 SlowDown must not end up as a
        // program fault that fails everybody's frame.
        const res = await this.withRetries(() =>
          this.fetchImpl(p.url as string, {
            method: "PUT",
            headers: p.headers,
            body: it.bytes as BodyInit,
          }),
        );
        if (!res.ok) throw new Error(`upload of ${it.hash} failed: ${res.status}`);
      }),
    );
    return items.map(({ hash, size }) => ({ hash, size }));
  }

  async get(hash: string, range?: { offset: number; length: number }): Promise<Uint8Array | null> {
    const init: RequestInit = range
      ? { headers: { range: `bytes=${range.offset}-${range.offset + range.length - 1}` } }
      : {};
    const res = await this.withRetries(() => this.fetchImpl(this.urlFor(hash), init));
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok && res.status !== 206) throw new Error(`fetch of ${hash} failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Three tries with a short backoff for network errors and 5xx / 429 answers (WP8.1). */
  private async withRetries(attempt: () => Promise<Response>): Promise<Response> {
    let last: unknown = null;
    for (let i = 0; i < 3; i++) {
      try {
        const res = await attempt();
        if (res.status < 500 && res.status !== 429) return res;
        last = new Error(`HTTP ${res.status}`);
      } catch (err) {
        last = err;
      }
      if (i < 2) await new Promise((r) => setTimeout(r, 250 * 2 ** i));
    }
    throw last instanceof Error ? last : new Error(String(last));
  }
}
