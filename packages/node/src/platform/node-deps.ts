// What a Node process needs to be a node: real sockets and timers, fetch, and the worker-thread
// sandbox. The cloud core inside the control-plane image and the local dev core both use it.
import { createNodeSandboxHost } from "@tabframe/sandbox/adapters/node-host";
import { StoreClient } from "@tabframe/store";
import type { Log } from "../connection.ts";
import type { OrchestratorDeps, Status } from "../orchestrator.ts";
import { globalTimers, webSocketLike } from "./socket.ts";

export interface NodeDepsOptions {
  sessionUrl: string;
  hostId: string;
  /** A cloud core's proof of identity for its hello; a local core has none. */
  coreToken?: string | null | undefined;
  /**
   * The sandbox worker entry. Defaults to `TABFRAME_SANDBOX_WORKER`: a bundled deployment stages
   * the worker beside the bundle, because one bundled file cannot be its own worker.
   */
  workerFile?: string | undefined;
  log: Log;
  onStatus: (status: Status) => void;
}

/** Blob reads for the sandbox bridge, straight from the store base the session hands out. */
export function blobReaderFor(
  storeBase: string,
): (hash: string, offset: number, len: number) => Promise<Uint8Array | null> {
  const reads = new StoreClient({
    base: storeBase,
    presign: () =>
      Promise.reject(new Error("a core reads blobs here; it uploads through its socket")),
  });
  return async (hash, offset, len) => {
    if (offset === 0 && !Number.isFinite(len)) return reads.get(hash);
    if (Number.isFinite(len)) return reads.get(hash, { offset, length: len });
    const whole = await reads.get(hash);
    return whole ? whole.slice(offset) : null;
  };
}

/** The orchestrator's dependencies for a core running under Node. */
export function nodeDeps(opts: NodeDepsOptions): OrchestratorDeps {
  const workerFile = opts.workerFile ?? process.env.TABFRAME_SANDBOX_WORKER;
  return {
    sessionUrl: opts.sessionUrl,
    hostId: opts.hostId,
    ...(opts.coreToken ? { coreToken: opts.coreToken } : {}),
    kind: "core",
    // A 0.5 GB core has a quarter vCPU that bursts to one; one worker is the honest number.
    cores: 1,
    sandboxVersion: "1",
    fetch: (url) => fetch(url),
    connect: webSocketLike,
    timers: globalTimers,
    createSandbox: (storeBase) =>
      createNodeSandboxHost({
        fetchBlob: blobReaderFor(storeBase),
        ...(workerFile ? { workerFile } : {}),
      }),
    onStatus: opts.onStatus,
    log: opts.log,
  };
}
