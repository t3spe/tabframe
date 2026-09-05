import { LIMITS } from "@tabframe/protocol";
import type { PresignedUpload, PresignItem } from "./driver.ts";
import { messageOf, StoreError } from "./errors.ts";
import { sha256Hex } from "./hash.ts";
import { DEFAULT_RETRY, type RetryPolicy, UPLOAD_TIMEOUT_MS, withRetries } from "./retry.ts";

/** Presign is a socket message (D18); the node and the page provide the round trip. */
export interface PresignRequester {
  presign(items: PresignItem[]): Promise<PresignedUpload[]>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** A blob the client hashed and the store now holds. */
export interface Uploaded {
  hash: string;
  size: number;
}

export interface StoreClientOptions {
  base: string;
  /** The presign round trip, as a requester or its function. */
  presign: PresignRequester | PresignRequester["presign"];
  fetch?: FetchLike;
  retry?: Partial<RetryPolicy>;
}

interface Hashed extends Uploaded {
  bytes: Uint8Array;
}

/**
 * The one client flow everywhere (design §7.1): hash locally, ask for presigned URLs over the
 * socket, PUT straight to the store with the pinned headers, and read blobs by hash from the CDN.
 * Every failure of the store or the network surfaces as a `StoreError`.
 */
export class StoreClient {
  private readonly base: string;
  private readonly requester: PresignRequester;
  private readonly fetchImpl: FetchLike;
  private readonly retry: RetryPolicy;

  constructor(options: StoreClientOptions);
  constructor(base: string, requester: PresignRequester, fetchImpl?: FetchLike);
  constructor(
    baseOrOptions: string | StoreClientOptions,
    requester?: PresignRequester,
    fetchImpl?: FetchLike,
  ) {
    const opts: StoreClientOptions =
      typeof baseOrOptions === "string"
        ? {
            base: baseOrOptions,
            presign: requester as PresignRequester,
            ...(fetchImpl ? { fetch: fetchImpl } : {}),
          }
        : baseOrOptions;
    this.base = opts.base.replace(/\/$/, "");
    this.requester = typeof opts.presign === "function" ? { presign: opts.presign } : opts.presign;
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
  }

  urlFor(hash: string): string {
    return `${this.base}/${hash}`;
  }

  async put(bytes: Uint8Array): Promise<Uploaded> {
    const [r] = await this.putMany([bytes]);
    if (!r) throw new Error("unreachable");
    return r;
  }

  /** Upload many blobs in one presign pass; the answer is positional. */
  async putMany(blobs: Uint8Array[]): Promise<Uploaded[]> {
    const items = await Promise.all(blobs.map((b) => hashed(b)));
    await this.upload(items);
    return items.map(({ hash, size }) => ({ hash, size }));
  }

  /** Upload blobs under caller-chosen names, and answer under the same names. */
  async putNamed(entries: Map<string, Uint8Array>): Promise<Map<string, Uploaded>> {
    const named = await Promise.all(
      [...entries].map(async ([name, bytes]) => ({ name, ...(await hashed(bytes)) })),
    );
    await this.upload(named);
    return new Map(named.map(({ name, hash, size }) => [name, { hash, size }]));
  }

  async get(hash: string, range?: { offset: number; length: number }): Promise<Uint8Array | null> {
    const init: RequestInit = range
      ? { headers: { range: `bytes=${range.offset}-${range.offset + range.length - 1}` } }
      : {};
    return withRetries(async (signal) => {
      const res = await this.fetchOnce(this.urlFor(hash), { ...init, signal });
      if (res.status === 404 || res.status === 403) return null;
      if (!res.ok && res.status !== 206) {
        throw new StoreError("http", `fetch of ${hash} failed: ${res.status}`, {
          status: res.status,
        });
      }
      return this.body(res, signal);
    }, this.retry);
  }

  /** Presign in batches of the protocol's cap, one round trip each, then PUT what the store lacks. */
  private async upload(items: Hashed[]): Promise<void> {
    const unique = new Map<string, Hashed>();
    for (const it of items) unique.set(it.hash, it);
    const wanted = [...unique.values()].map(({ hash, size }) => ({ hash, size }));
    const byHash = new Map<string, PresignedUpload>();
    for (let i = 0; i < wanted.length; i += LIMITS.maxPresignItems) {
      const batch = await this.requester.presign(wanted.slice(i, i + LIMITS.maxPresignItems));
      for (const p of batch) byHash.set(p.hash, p);
    }
    await Promise.all(
      [...unique.values()].map(async (it) => {
        const p = byHash.get(it.hash);
        if (!p) throw new StoreError("presign", `no presign for ${it.hash}`);
        const url = p.url;
        if (url === null) return;
        const res = await withRetries(
          (signal) =>
            this.fetchOnce(url, {
              method: "PUT",
              headers: p.headers,
              body: it.bytes as BodyInit,
              signal,
            }),
          { ...this.retry, timeoutMs: UPLOAD_TIMEOUT_MS },
        );
        if (!res.ok) {
          throw new StoreError("http", `upload of ${it.hash} failed: ${res.status}`, {
            status: res.status,
          });
        }
      }),
    );
  }

  /** One attempt: a thrown fetch is a network or timeout failure, a 5xx or 429 an HTTP one. */
  private async fetchOnce(
    url: string,
    init: RequestInit & { signal: AbortSignal },
  ): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (err) {
      throw new StoreError(init.signal.aborted ? "timeout" : "network", messageOf(err), {
        cause: err,
      });
    }
    if (res.status >= 500 || res.status === 429) {
      throw new StoreError("http", `HTTP ${res.status}`, { status: res.status });
    }
    return res;
  }

  /** The body read is bounded by the same signal as the request. */
  private async body(res: Response, signal: AbortSignal): Promise<Uint8Array> {
    try {
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      throw new StoreError(signal.aborted ? "timeout" : "network", messageOf(err), { cause: err });
    }
  }
}

async function hashed(bytes: Uint8Array): Promise<Hashed> {
  return { hash: await sha256Hex(bytes), size: bytes.length, bytes };
}
