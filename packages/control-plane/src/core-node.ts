// A cloud core's node (design §9.3): the same orchestrator a browser tab runs, started inside the
// image when the run payload says `role: core`. Its host id names the MicroVM, which is how the
// control plane links the node to the core it launched (§6.8).

import { Orchestrator, type SocketLike, type Status } from "@tabframe/node";
import { createNodeSandboxHost } from "@tabframe/sandbox/adapters/node-host";
import { StoreClient } from "@tabframe/store";

export interface CoreOptions {
  sessionUrl: string;
  microvmId: string | null;
  /** The run payload's core token, shown at hello (WP8.2). */
  coreToken?: string | null;
  log: (event: string, fields?: Record<string, unknown>) => void;
  /** Test seam: skip the real sockets. */
  start?: boolean;
  /** The sandbox worker entry; defaults to `TABFRAME_SANDBOX_WORKER` or the package's source. */
  workerFile?: string;
}

/** Blob reads for the sandbox bridge, straight from the store base the session hands out. */
export function blobReaderFor(storeBase: string) {
  const reads = new StoreClient(storeBase, {
    presign: () => Promise.reject(new Error("a core reads blobs; it uploads through its socket")),
  });
  return async (hash: string, offset: number, len: number): Promise<Uint8Array | null> => {
    if (offset === 0 && !Number.isFinite(len)) return reads.get(hash);
    if (Number.isFinite(len)) return reads.get(hash, { offset, length: len });
    const whole = await reads.get(hash);
    return whole ? whole.slice(offset) : null;
  };
}

export function startCore(opts: CoreOptions): Orchestrator {
  const hostId = `core-${opts.microvmId ?? `unknown-${process.pid}`}`;
  const workerFile = opts.workerFile ?? process.env.TABFRAME_SANDBOX_WORKER;
  const orchestrator = new Orchestrator({
    sessionUrl: opts.sessionUrl,
    hostId,
    ...(opts.coreToken ? { coreToken: opts.coreToken } : {}),
    kind: "core",
    // A 0.5 GB core has a quarter vCPU that bursts to one; one worker is the honest number.
    cores: 1,
    sandboxVersion: "1",
    fetch: (url) => fetch(url),
    connect: (url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike,
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    },
    createSandbox: (storeBase) =>
      createNodeSandboxHost({
        fetchBlob: blobReaderFor(storeBase),
        // In the MicroVM image everything is one bundled file, so the worker entry is staged
        // beside it and named by the environment; a checkout uses the package's own source.
        ...(workerFile ? { workerFile } : {}),
      }),
    onStatus: (status: Status) => {
      opts.log("core-status", { state: status.state, nodeId: status.nodeId, queue: status.queue });
    },
    log: (event, fields) => opts.log(`core-${event}`, fields),
  });
  if (opts.start !== false) void orchestrator.start();
  return orchestrator;
}
