import { PROTOCOL_VERSION } from "@tabframe/protocol";
import {
  type PresignedUpload,
  type PresignItem,
  type PresignRequester,
  StoreError,
} from "@tabframe/store";

/** How long a node waits for a presign answer before releasing the task. */
export const PRESIGN_TIMEOUT_MS = 30_000;

/** Presign over the node socket (D18): one outstanding request at a time, matched by hash set. */
export class SocketPresigner implements PresignRequester {
  private readonly send: (text: string) => void;
  private readonly timeoutMs: number;
  private waiting: {
    hashes: Set<string>;
    resolve: (v: PresignedUpload[]) => void;
    reject: (e: Error) => void;
  } | null = null;
  private gen = 0;

  constructor(send: (text: string) => void, timeoutMs = PRESIGN_TIMEOUT_MS) {
    this.send = send;
    this.timeoutMs = timeoutMs;
  }

  setGeneration(gen: number): void {
    this.gen = gen;
  }

  presign(items: PresignItem[]): Promise<PresignedUpload[]> {
    return new Promise((resolve, reject) => {
      if (this.waiting) {
        reject(new Error("a presign is already outstanding"));
        return;
      }
      const w = { hashes: new Set(items.map((i) => i.hash)), resolve, reject };
      this.waiting = w;
      // A presign the control plane never answers must not hold the node for ever: the task is
      // released and the node moves on.
      const timer = setTimeout(() => {
        if (this.waiting !== w) return;
        this.waiting = null;
        reject(new StoreError("presign", "presign timed out"));
      }, this.timeoutMs);
      w.resolve = (v) => {
        clearTimeout(timer);
        resolve(v);
      };
      w.reject = (e) => {
        clearTimeout(timer);
        reject(e);
      };
      this.send(JSON.stringify({ t: "presign", v: PROTOCOL_VERSION, gen: this.gen, items }));
    });
  }

  /** Feed the `presigned` message; true when it satisfied the outstanding request. */
  deliver(urls: PresignedUpload[]): boolean {
    const w = this.waiting;
    if (!w) return false;
    if (!urls.every((u) => w.hashes.has(u.hash))) return false;
    this.waiting = null;
    w.resolve(urls);
    return true;
  }

  /** The socket died: fail the outstanding request. */
  reset(): void {
    const w = this.waiting;
    this.waiting = null;
    w?.reject(new StoreError("presign", "socket closed"));
  }
}
