// Web adapter, host side: a dependency-free helper the browser orchestrator (packages/node) uses
// to spawn the sandbox worker, hand it tasks, and terminate it at the deadline (design §4.2).
import { createSandboxHost, type SandboxHost, type WorkerLike } from "../host.ts";
import type { HostRequest, TaskResult } from "../types.ts";

interface BrowserWorker {
  postMessage(msg: unknown): void;
  terminate(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

type WorkerCtor = new (url: string | URL, opts: { type: "module"; name?: string }) => BrowserWorker;

export interface WebSandboxHost {
  run(module: WebAssembly.Module, request: HostRequest, deadlineMs: number): Promise<TaskResult>;
  dispose(): void;
}

/** Wrap a browser Worker in the host's worker shape. */
export function wrapBrowserWorker(w: BrowserWorker): WorkerLike {
  return {
    postMessage: (m) => w.postMessage(m),
    terminate: () => w.terminate(),
    onMessage: (h) => {
      w.onmessage = (ev) => h(ev.data);
    },
    onError: (h) => {
      w.onerror = (ev) => h(ev);
    },
  };
}

/**
 * The sandbox host for a browser node: `workerUrl` is the bundled web-worker entry, `storeBase`
 * is where the worker fetches blobs by hash.
 */
export function createWebSandboxHost(workerUrl: string | URL, storeBase: string): WebSandboxHost {
  const Ctor = (globalThis as { Worker?: WorkerCtor }).Worker;
  if (!Ctor) throw new Error("no Worker constructor in this environment");
  const host: SandboxHost = createSandboxHost(() =>
    wrapBrowserWorker(new Ctor(workerUrl, { type: "module", name: "tabframe-sandbox" })),
  );
  return {
    run: (module, request, deadlineMs) => host.run(module, request, deadlineMs, { storeBase }),
    dispose: () => host.dispose(),
  };
}
