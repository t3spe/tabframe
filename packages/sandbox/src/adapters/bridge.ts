import type { BlobReader } from "../types.ts";

/**
 * The Atomics bridge (design §4.2, node adapter): a sandbox thread blocks on a SharedArrayBuffer
 * while the orchestrator thread fetches bytes asynchronously and drops them into the buffer.
 *
 *   header (Int32Array over the first 16 bytes): [0] status, [1] bytes delivered
 *   data region: the rest of the buffer; reads longer than the region are chunked
 */
export const BRIDGE_HEADER_BYTES = 16;
export const DEFAULT_REGION_BYTES = 4 * 1024 * 1024;
export const BRIDGE = { waiting: 0, ready: 1, notFound: 2 } as const;

export interface BlobRequest {
  type: "blob";
  hash: string;
  offset: number;
  len: number;
}

export function isBlobRequest(msg: unknown): msg is BlobRequest {
  return typeof msg === "object" && msg !== null && (msg as { type?: unknown }).type === "blob";
}

export function createBridgeBuffer(regionBytes = DEFAULT_REGION_BYTES): SharedArrayBuffer {
  return new SharedArrayBuffer(BRIDGE_HEADER_BYTES + regionBytes);
}

/** Worker side: post a request, block until the host answers, collect chunks. */
export class BridgeBlobReader implements BlobReader {
  private readonly header: Int32Array;
  private readonly data: Uint8Array;
  private readonly post: (req: BlobRequest) => void;

  constructor(sab: SharedArrayBuffer, post: (req: BlobRequest) => void) {
    this.header = new Int32Array(sab, 0, BRIDGE_HEADER_BYTES / 4);
    this.data = new Uint8Array(sab, BRIDGE_HEADER_BYTES);
    this.post = post;
  }

  read(hash: string, offset: number, len: number): Uint8Array | null {
    const chunks: Uint8Array[] = [];
    let pos = offset;
    let remaining = len;
    for (;;) {
      const want = Math.min(remaining, this.data.length);
      if (want <= 0) break;
      Atomics.store(this.header, 0, BRIDGE.waiting);
      this.post({ type: "blob", hash, offset: pos, len: want });
      Atomics.wait(this.header, 0, BRIDGE.waiting);
      if (Atomics.load(this.header, 0) === BRIDGE.notFound) {
        return chunks.length > 0 ? concat(chunks) : null;
      }
      const n = Atomics.load(this.header, 1);
      if (n > 0) chunks.push(this.data.slice(0, n));
      pos += n;
      remaining -= n;
      if (n < want) break;
    }
    return concat(chunks);
  }
}

/** Host side: answer one request by filling the region and flipping the status. */
export async function serviceBlobRequest(
  sab: SharedArrayBuffer,
  req: BlobRequest,
  fetchBlob: (hash: string, offset: number, len: number) => Promise<Uint8Array | null>,
): Promise<void> {
  const header = new Int32Array(sab, 0, BRIDGE_HEADER_BYTES / 4);
  const data = new Uint8Array(sab, BRIDGE_HEADER_BYTES);
  let bytes: Uint8Array | null = null;
  try {
    bytes = await fetchBlob(req.hash, req.offset, req.len);
  } catch {
    bytes = null;
  }
  if (!bytes) {
    Atomics.store(header, 0, BRIDGE.notFound);
    Atomics.notify(header, 0);
    return;
  }
  const n = Math.min(bytes.length, data.length, req.len);
  data.set(bytes.subarray(0, n));
  Atomics.store(header, 1, n);
  Atomics.store(header, 0, BRIDGE.ready);
  Atomics.notify(header, 0);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}
