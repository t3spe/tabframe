/// <reference lib="webworker" />
/**
 * Browser platform: this file is the Web Worker a host page spawns per node. The worker owns the
 * socket, the heartbeat, and the sandbox worker; the host only sends init and visibility and
 * receives status.
 */
import { createWebSandboxHost } from "@tabframe/sandbox/adapters/web-host";
import { Orchestrator, type SocketLike, type Status } from "../orchestrator.ts";

interface InitMessage {
  type: "init";
  sessionUrl: string;
  hostId: string;
  visible: boolean;
  /** The bundled sandbox worker; defaults to `sandbox.js` next to this worker's script. */
  sandboxUrl?: string;
}
interface VisibilityMessage {
  type: "visibility";
  visible: boolean;
}
interface StopMessage {
  type: "stop";
}
export type HostToWorker = InitMessage | VisibilityMessage | StopMessage;
export type WorkerToHost = { type: "status" } & Status;

const scope = self as unknown as DedicatedWorkerGlobalScope;
let orchestrator: Orchestrator | null = null;

scope.onmessage = (ev: MessageEvent<HostToWorker>) => {
  const msg = ev.data;
  switch (msg.type) {
    case "init": {
      if (orchestrator) return;
      const sandboxUrl = msg.sandboxUrl ?? new URL("./sandbox.js", scope.location.href).href;
      orchestrator = new Orchestrator({
        sessionUrl: msg.sessionUrl,
        hostId: msg.hostId,
        kind: "tab",
        cores: scope.navigator?.hardwareConcurrency ?? 1,
        sandboxVersion: "1",
        fetch: (url) => fetch(url, { cache: "no-store" }),
        connect: (url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike,
        timers: {
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout: (h) => clearTimeout(h as number),
        },
        createSandbox: (storeBase) => createWebSandboxHost(sandboxUrl, storeBase),
        onStatus: (status) => {
          scope.postMessage({ type: "status", ...status } satisfies WorkerToHost);
          // A close command ends this node; the host decides whether to spawn another.
          if (status.state === "closed") scope.close();
        },
      });
      orchestrator.setVisible(msg.visible);
      void orchestrator.start();
      return;
    }
    case "visibility":
      orchestrator?.setVisible(msg.visible);
      return;
    case "stop":
      orchestrator?.stop();
      scope.close();
      return;
  }
};
