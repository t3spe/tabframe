// Node adapter, host side: spawns the worker thread, services its blob requests asynchronously,
// and enforces deadlines by terminating it (design §4.2).
import { Worker } from "node:worker_threads";
import { createSandboxHost, type SandboxHost, type WorkerLike } from "../host.ts";
import { createBridgeBuffer, isBlobRequest, serviceBlobRequest } from "./bridge.ts";

export interface NodeSandboxOptions {
  /** The worker entry; defaults to this package's node-worker. */
  workerFile?: string | URL;
  /** Async source of blob bytes for the bridge (the orchestrator's fetch by hash). */
  fetchBlob: (hash: string, offset: number, len: number) => Promise<Uint8Array | null>;
  regionBytes?: number;
}

export function createNodeSandboxHost(opts: NodeSandboxOptions): SandboxHost {
  const sab = createBridgeBuffer(opts.regionBytes);
  const file = opts.workerFile ?? new URL("./node-worker.ts", import.meta.url);
  const spawn = (): WorkerLike => {
    const w = new Worker(file, { workerData: { sab } });
    return {
      postMessage: (m) => w.postMessage(m),
      terminate: () => {
        void w.terminate();
      },
      onMessage: (h) => {
        w.on("message", h);
      },
      onError: (h) => {
        w.on("error", h);
        w.on("exit", (code) => {
          if (code !== 0) h(new Error(`worker exited with code ${code}`));
        });
      },
    };
  };
  return createSandboxHost(spawn, (msg) => {
    if (isBlobRequest(msg)) void serviceBlobRequest(sab, msg, opts.fetchBlob);
  });
}
