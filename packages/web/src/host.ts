// The host page (design §3): one observer socket for the dashboard, zero or more node workers.
import type { HostToWorker, WorkerToHost } from "@tabframe/node/platform/web";
import type { NodeView } from "@tabframe/protocol";
import { type MachineState, ObserverClient } from "./observer.ts";
import { type ClusterState, hostCount } from "./state.ts";

interface LocalNode {
  id: number;
  worker: Worker;
  status: WorkerToHost | null;
}

const $ = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

const hostId = crypto.randomUUID().slice(0, 8);
const observeOnly = new URLSearchParams(location.search).has("observe");
const cores = navigator.hardwareConcurrency || 1;
const locals = new Map<number, LocalNode>();
let localCounter = 0;
let sessionUrl = "";

const els = {
  machine: $<HTMLSpanElement>("#machine"),
  gen: $<HTMLSpanElement>("#gen"),
  counts: $<HTMLSpanElement>("#counts"),
  seq: $<HTMLSpanElement>("#seq"),
  banner: $<HTMLDivElement>("#banner"),
  table: $<HTMLTableElement>("#nodes"),
  tbody: $<HTMLTableSectionElement>("#nodes tbody"),
  mine: $<HTMLDivElement>("#mine"),
  spawn1: $<HTMLButtonElement>("#spawn1"),
  spawnN: $<HTMLButtonElement>("#spawnN"),
  spawnCount: $<HTMLSpanElement>("#spawnCount"),
  killMine: $<HTMLButtonElement>("#killMine"),
  coresNote: $<HTMLParagraphElement>("#coresNote"),
};

const spawnDefault = Math.max(1, cores - 1);
els.spawnCount.textContent = String(spawnDefault);
els.coresNote.textContent = `This machine reports ${cores} cores. Nodes in this tab share them, so more than ${spawnDefault} adds little.`;

function setMachine(state: MachineState, detail?: string): void {
  const label = detail ? `${state} · ${detail}` : state;
  els.machine.textContent = label;
  els.machine.className = `pill ${state === "live" ? "live" : state === "off" || state === "outdated" ? "off" : "wait"}`;
  if (state === "live") {
    els.banner.hidden = true;
    els.table.hidden = false;
  } else {
    els.table.hidden = true;
    els.banner.hidden = false;
    els.banner.innerHTML =
      state === "off"
        ? "<strong>The machine is off.</strong><br>An operator turns it back on with <code>mise run up</code>."
        : state === "starting"
          ? "<strong>Starting the control plane…</strong><br>A fresh MicroVM is booting from its snapshot."
          : state === "outdated"
            ? "<strong>This page is out of date.</strong><br>Reloading…"
            : `<strong>Connecting…</strong><br>${detail ?? "Waking the machine if it is asleep."}`;
    if (state === "outdated") setTimeout(() => location.reload(), 1_500);
  }
}

function renderCluster(state: ClusterState): void {
  els.gen.textContent = `gen ${state.generation ?? "—"}`;
  els.seq.textContent = `seq ${state.seq}`;
  els.counts.textContent = `${state.nodes.size} nodes · ${hostCount(state)} hosts`;
  const mineIds = new Set([...locals.values()].map((l) => l.status?.nodeId).filter(Boolean));
  const rows = [...state.nodes.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  els.tbody.replaceChildren(...rows.map((n) => row(n, mineIds.has(n.nodeId))));
}

function row(n: NodeView, mine: boolean): HTMLTableRowElement {
  const tr = document.createElement("tr");
  const cells = [
    n.nodeId + (mine ? " ★" : ""),
    n.hostId,
    n.kind,
    n.health,
    n.visible ? "yes" : "hidden",
    String(n.tasksDone),
    String(n.inFlight),
    new Date(n.joinedAt).toLocaleTimeString(),
  ];
  cells.forEach((text, i) => {
    const td = document.createElement("td");
    td.textContent = text;
    if (i === 5 || i === 6) td.className = "num";
    if (i === 3) td.className = `health-${n.health}`;
    if (i === 0 && mine) td.className = "mine";
    tr.appendChild(td);
  });
  tr.dataset.nodeId = n.nodeId;
  return tr;
}

function renderMine(): void {
  els.mine.replaceChildren(
    ...[...locals.values()].map((l) => {
      const div = document.createElement("div");
      div.className = "row";
      div.dataset.local = String(l.id);
      const label = document.createElement("span");
      label.textContent = `${l.status?.nodeId ?? "…"} · ${l.status?.state ?? "starting"}${l.status?.detail ? ` · ${l.status.detail}` : ""}`;
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "close";
      close.onclick = () => closeLocal(l.id);
      div.append(label, close);
      return div;
    }),
  );
  if (locals.size === 0) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = observeOnly
      ? "Observe-only mode: this tab lends no CPU."
      : "No nodes in this tab.";
    els.mine.appendChild(p);
  }
}

function spawn(count: number): void {
  for (let i = 0; i < count; i++) {
    const id = ++localCounter;
    const worker = new Worker(new URL("./node.js", import.meta.url), {
      type: "module",
      name: `tabframe-node-${id}`,
    });
    const local: LocalNode = { id, worker, status: null };
    worker.onmessage = (ev: MessageEvent<WorkerToHost>) => {
      local.status = ev.data;
      if (ev.data.state === "outdated") setMachine("outdated");
      renderMine();
      renderCluster(observer.cluster);
    };
    worker.onerror = (e) => console.error("node worker error", e.message);
    const init: HostToWorker = {
      type: "init",
      sessionUrl,
      hostId,
      visible: document.visibilityState === "visible",
    };
    worker.postMessage(init);
    locals.set(id, local);
  }
  renderMine();
}

function closeLocal(id: number): void {
  const l = locals.get(id);
  if (!l) return;
  const stop: HostToWorker = { type: "stop" };
  l.worker.postMessage(stop);
  setTimeout(() => l.worker.terminate(), 200);
  locals.delete(id);
  renderMine();
}

els.spawn1.onclick = () => spawn(1);
els.spawnN.onclick = () => spawn(spawnDefault);
els.killMine.onclick = () => {
  for (const id of [...locals.keys()]) closeLocal(id);
};
document.addEventListener("visibilitychange", () => {
  const msg: HostToWorker = { type: "visibility", visible: document.visibilityState === "visible" };
  for (const l of locals.values()) l.worker.postMessage(msg);
});

const observer = new ObserverClient("", {
  onState: setMachine,
  onCluster: renderCluster,
  onSession: () => {},
});

async function main(): Promise<void> {
  setMachine("connecting");
  const config = (await (await fetch("/config.json", { cache: "no-store" })).json()) as {
    sessionUrl: string;
  };
  sessionUrl = new URL(config.sessionUrl, location.origin).toString();
  const client = new ObserverClient(sessionUrl, {
    onState: setMachine,
    onCluster: renderCluster,
    onSession: () => {
      if (!observeOnly && locals.size === 0 && !spawnedOnce) {
        spawnedOnce = true;
        spawn(1);
      }
    },
  });
  Object.assign(observer, client);
  renderMine();
  await client.start();
  (window as unknown as { tabframe: unknown }).tabframe = { client, locals, hostId };
}
let spawnedOnce = false;
void main();
