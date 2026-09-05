import type { FsManifest, TaskLimits } from "@tabframe/protocol";

/**
 * Synchronous bytes for a hash (design §4.2). WebAssembly imports are synchronous, so the glue
 * needs bytes without awaiting: a cache, a synchronous XMLHttpRequest in a dedicated worker, or
 * an Atomics handshake with a servicing thread. `len` may be Infinity for "the whole blob".
 */
export interface BlobReader {
  read(hash: string, offset: number, len: number): Uint8Array | null;
}

export type TaskKind = "run" | "plan";

/** What a host hands its worker: everything but the reader, which the worker builds itself. */
export interface HostRequest {
  kind: TaskKind;
  input: Uint8Array;
  manifest: FsManifest;
  limits: TaskLimits;
}

/** What `runTask` takes: the host's request plus the worker's reader. */
export type TaskRequest = HostRequest & { reader: BlobReader };

export type TaskResult =
  | {
      ok: true;
      output: Uint8Array;
      writes: Map<string, Uint8Array>;
      log: string;
      computeMs: number;
    }
  | { ok: false; error: string; log: string };
