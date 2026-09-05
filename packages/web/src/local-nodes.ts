// The nodes this tab lends: one Web Worker each, running the orchestrator from @tabframe/node.
import type { HostToWorker, WorkerToHost } from "@tabframe/node/platform/web";
import { el } from "./dom.ts";
import { fmtMs } from "./format.ts";

export interface LocalNode {
  id: number;
  worker: Worker;
  status: WorkerToHost | null;
}

export interface LocalNodesDeps {
  sessionUrl(): string;
  hostId: string;
  /** A node's status moved, or one was spawned or closed. */
  onChange(): void;
  /** A worker reported a status; the page reacts to `outdated`. */
  onStatus(status: WorkerToHost): void;
}

export class LocalNodes {
  private readonly nodes = new Map<number, LocalNode>();
  private readonly deps: LocalNodesDeps;
  private counter = 0;

  constructor(deps: LocalNodesDeps) {
    this.deps = deps;
    document.addEventListener("visibilitychange", () =>
      this.setVisible(document.visibilityState === "visible"),
    );
  }

  get size(): number {
    return this.nodes.size;
  }

  values(): IterableIterator<LocalNode> {
    return this.nodes.values();
  }

  /** The cluster ids of this tab's nodes, once their workers have reported them. */
  nodeIds(): Set<string> {
    const ids = new Set<string>();
    for (const l of this.nodes.values()) if (l.status?.nodeId) ids.add(l.status.nodeId);
    return ids;
  }

  spawn(count: number): void {
    for (let i = 0; i < count; i++) {
      const id = ++this.counter;
      const worker = new Worker(new URL("./node.js", import.meta.url), {
        type: "module",
        name: `tabframe-node-${id}`,
      });
      const local: LocalNode = { id, worker, status: null };
      worker.onmessage = (ev: MessageEvent<WorkerToHost>) => {
        local.status = ev.data;
        this.deps.onStatus(ev.data);
        this.deps.onChange();
      };
      worker.onerror = (e) => console.error("node worker error", e.message);
      const init: HostToWorker = {
        type: "init",
        sessionUrl: this.deps.sessionUrl(),
        hostId: this.deps.hostId,
        visible: document.visibilityState === "visible",
      };
      worker.postMessage(init);
      this.nodes.set(id, local);
    }
    this.deps.onChange();
  }

  close(id: number): void {
    const l = this.nodes.get(id);
    if (!l) return;
    const stop: HostToWorker = { type: "stop" };
    l.worker.postMessage(stop);
    setTimeout(() => l.worker.terminate(), 200);
    this.nodes.delete(id);
    this.deps.onChange();
  }

  closeAll(): void {
    for (const id of [...this.nodes.keys()]) this.close(id);
  }

  setVisible(visible: boolean): void {
    const msg: HostToWorker = { type: "visibility", visible };
    for (const l of this.nodes.values()) l.worker.postMessage(msg);
  }
}

/** The "Your nodes" list: one row per local node, or a line saying why there are none. */
export function renderLocalNodes(box: HTMLElement, locals: LocalNodes, emptyText: string): void {
  box.replaceChildren(
    ...[...locals.values()].map((l) => {
      const div = el("div", "row");
      div.dataset.local = String(l.id);
      const s = l.status;
      const label = el(
        "span",
        undefined,
        `${s?.nodeId ?? "…"} · ${s?.state ?? "starting"}${s?.detail ? ` · ${s.detail}` : ""}${s && s.tasksDone > 0 ? ` · ${s.tasksDone} done · ${fmtMs(s.lastTaskMs)}` : ""}`,
      );
      const close = el("button", undefined, "close");
      close.type = "button";
      close.onclick = () => locals.close(l.id);
      div.append(label, close);
      return div;
    }),
  );
  if (locals.size === 0) box.appendChild(el("p", "muted", emptyText));
}
