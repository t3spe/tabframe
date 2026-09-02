// The host page (design §3): one observer socket for the dashboard, zero or more node workers.
// The canvas is the hero: finished tiles land on it as they are verified, and the scheduler's
// state is drawn over the rectangles that are still open.
import type { HostToWorker, WorkerToHost } from "@tabframe/node/platform/web";
import type { NodeView, PlaceView } from "@tabframe/protocol";
import { type DemoHandle, startDemo } from "./demo.ts";
import { type ControlRequest, type MachineState, ObserverClient } from "./observer.ts";
import {
  applyMessage,
  type ClusterState,
  emptyState,
  hostCount,
  inFlightByNode,
  isFlashing,
  planTask,
  progress,
  stageTasks,
  type TaskColor,
  taskColor,
  throughput,
  withRedundancy,
} from "./state.ts";
import {
  type BlobSource,
  storeSource,
  type TileFlag,
  type TilePainter,
  TileView,
} from "./tiles.ts";

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

/** Okabe–Ito, distinguishable under the common color-vision deficiencies; luminance separates them too. */
export const COLORS: Record<TaskColor, string> = {
  pending: "#3a4250",
  assigned: "#56b4e9",
  speculated: "#cc79a7",
  done: "#009e73",
  verified: "#0072b2",
  mismatch: "#f0e442",
  failed: "#d55e00",
};
const LEGEND: [TaskColor | "flash" | "contested", string][] = [
  ["pending", "pending"],
  ["assigned", "assigned"],
  ["speculated", "speculated twin"],
  ["done", "done"],
  ["verified", "verified"],
  ["mismatch", "mismatch, recomputing"],
  ["failed", "failed"],
  ["flash", "taken back"],
  ["contested", "contested"],
];
const FLASH = "#ffffff";
const BG = "#0b0d10";

const params = new URLSearchParams(location.search);
const demoMode = params.has("demo");
const observeOnly = params.has("observe") || demoMode;
const hostId = crypto.randomUUID().slice(0, 8);
const cores = navigator.hardwareConcurrency || 1;
const locals = new Map<number, LocalNode>();
let localCounter = 0;
let sessionUrl = "";
let latest: ClusterState = emptyState();
let machine: MachineState = "connecting";
let demoTime = Date.now();
const clockNow = (): number => (demoMode ? demoTime : Date.now());

const els = {
  machine: $<HTMLSpanElement>("#machine"),
  gen: $<HTMLSpanElement>("#gen"),
  counts: $<HTMLSpanElement>("#counts"),
  seq: $<HTMLSpanElement>("#seq"),
  exec: $<HTMLSpanElement>("#exec"),
  rate: $<HTMLSpanElement>("#rate"),
  notice: $<HTMLDivElement>("#notice"),
  banner: $<HTMLDivElement>("#banner"),
  stage: $<HTMLDivElement>("#stage"),
  execName: $<HTMLSpanElement>("#execName"),
  execDetail: $<HTMLSpanElement>("#execDetail"),
  progressFill: $<HTMLDivElement>("#progressFill"),
  progressText: $<HTMLSpanElement>("#progressText"),
  tiles: $<HTMLCanvasElement>("#tiles"),
  viewNote: $<HTMLDivElement>("#viewNote"),
  grid: $<HTMLCanvasElement>("#grid"),
  legend: $<HTMLDivElement>("#legend"),
  counters: $<HTMLDivElement>("#counters"),
  table: $<HTMLTableElement>("#nodes"),
  tbody: $<HTMLTableSectionElement>("#nodes tbody"),
  queue: $<HTMLUListElement>("#queue"),
  activity: $<HTMLUListElement>("#activity"),
  mine: $<HTMLDivElement>("#mine"),
  spawn1: $<HTMLButtonElement>("#spawn1"),
  spawnN: $<HTMLButtonElement>("#spawnN"),
  spawnCount: $<HTMLSpanElement>("#spawnCount"),
  killMine: $<HTMLButtonElement>("#killMine"),
  coresNote: $<HTMLParagraphElement>("#coresNote"),
  redundancy: $<HTMLInputElement>("#redundancy"),
  tileStats: $<HTMLSpanElement>("#tileStats"),
};
const controlButtons: [HTMLButtonElement, ControlRequest][] = [
  [$<HTMLButtonElement>("#killHalf"), { t: "killHalf" }],
  [$<HTMLButtonElement>("#freezeHalf"), { t: "freezeHalf" }],
  [$<HTMLButtonElement>("#throttleHalf"), { t: "throttleHalf" }],
  [$<HTMLButtonElement>("#resumeAll"), { t: "resumeAll" }],
  [$<HTMLButtonElement>("#restart"), { t: "restart" }],
  [$<HTMLButtonElement>("#skip"), { t: "skip" }],
];

const spawnDefault = Math.max(1, cores - 1);
els.spawnCount.textContent = String(spawnDefault);
els.coresNote.textContent = `This machine reports ${cores} cores. Nodes in this tab share them, so more than ${spawnDefault} adds little.`;
els.legend.replaceChildren(
  ...LEGEND.map(([key, label]) => {
    const item = document.createElement("span");
    item.className = "legend-item";
    const swatch = document.createElement("i");
    swatch.className = `swatch swatch-${key}`;
    if (key !== "flash" && key !== "contested") swatch.style.background = COLORS[key];
    item.append(swatch, label);
    return item;
  }),
);

// ---- the canvas ------------------------------------------------------------------------------

/** Offscreen surface at the execution's size; the visible canvas shows it at half size with overlays. */
class CanvasPainter implements TilePainter {
  private readonly off = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly display: HTMLCanvasElement;
  private readonly dctx: CanvasRenderingContext2D;
  private scale = 0.5;
  private raf = 0;
  /** Rectangles the dashboard refused, so the overlay keeps outlining them. */
  readonly flagged = new Map<string, { place: PlaceView; flag: TileFlag }>();
  constructor(display: HTMLCanvasElement) {
    this.display = display;
    this.ctx = this.off.getContext("2d") as CanvasRenderingContext2D;
    this.dctx = display.getContext("2d") as CanvasRenderingContext2D;
    this.reset(2048, 1280);
  }
  reset(w: number, h: number): void {
    this.off.width = w;
    this.off.height = h;
    this.ctx.fillStyle = BG;
    this.ctx.fillRect(0, 0, w, h);
    this.scale = Math.min(1024 / w, 640 / h, 1);
    this.display.width = Math.round(w * this.scale);
    this.display.height = Math.round(h * this.scale);
    this.flagged.clear();
    this.present();
  }
  put(place: PlaceView, rgba: Uint8ClampedArray): void {
    const pixels = rgba as Uint8ClampedArray<ArrayBuffer>;
    this.ctx.putImageData(new ImageData(pixels, place.w, place.h), place.x, place.y);
    this.flagged.delete(key(place));
    this.present();
  }
  flag(place: PlaceView, flag: TileFlag): void {
    this.flagged.set(key(place), { place, flag });
    this.present();
  }
  clear(place: PlaceView): void {
    this.ctx.fillStyle = BG;
    this.ctx.fillRect(place.x, place.y, place.w, place.h);
    this.flagged.delete(key(place));
    this.present();
  }
  /** Draw the surface plus the scheduler's overlay; batched to one frame. */
  present(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }
  private draw(): void {
    const d = this.dctx;
    const s = this.scale;
    d.drawImage(this.off, 0, 0, this.display.width, this.display.height);
    const now = clockNow();
    const exec = latest.execution;
    if (exec?.view !== "tiles") return;
    for (const t of stageTasks(latest)) {
      if (!t.place) continue;
      const { x, y, w, h } = t.place;
      const color = taskColor(t);
      const flashing = isFlashing(t.flashAt, now);
      if (t.status !== "done") {
        d.fillStyle = COLORS[color];
        d.globalAlpha = color === "pending" ? 0.55 : 0.85;
        d.fillRect(x * s + 1, y * s + 1, w * s - 2, h * s - 2);
        d.globalAlpha = 1;
      } else if (t.verified) {
        d.fillStyle = COLORS.verified;
        d.fillRect(x * s + 2, y * s + 2, 6, 6);
      }
      if (t.contested) {
        d.strokeStyle = COLORS.mismatch;
        d.lineWidth = 2;
        d.strokeRect(x * s + 1, y * s + 1, w * s - 2, h * s - 2);
      }
      if (flashing) {
        d.strokeStyle = FLASH;
        d.lineWidth = 2;
        d.strokeRect(x * s + 1, y * s + 1, w * s - 2, h * s - 2);
      }
    }
    for (const { place, flag } of this.flagged.values()) {
      d.strokeStyle = flag === "missing" ? "#8a94a3" : COLORS.failed;
      d.lineWidth = 3;
      d.strokeRect(place.x * s + 1.5, place.y * s + 1.5, place.w * s - 3, place.h * s - 3);
    }
  }
}
const key = (p: PlaceView): string => `${p.x},${p.y}`;

const painter = new CanvasPainter(els.tiles);
const demoStore = new Map<string, Uint8Array>();
let blobSource: BlobSource = {
  async get(hash) {
    return demoStore.get(hash) ?? null;
  },
};
const tiles = new TileView({ get: (h) => blobSource.get(h) }, painter);
tiles.onChange = () => scheduleRender();

// ---- the task grid ---------------------------------------------------------------------------

function drawGrid(state: ClusterState): void {
  const rows = stageTasks(state);
  const c = els.grid;
  const width = Math.max(200, Math.floor(c.clientWidth || 1024));
  const n = rows.length;
  if (n === 0) {
    c.hidden = true;
    return;
  }
  c.hidden = false;
  const cell = Math.max(3, Math.min(14, Math.floor(Math.sqrt((width * 96) / n))));
  const cols = Math.max(1, Math.floor(width / cell));
  const lines = Math.ceil(n / cols);
  const height = lines * cell;
  if (c.width !== width || c.height !== height) {
    c.width = width;
    c.height = height;
  }
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  g.fillStyle = BG;
  g.fillRect(0, 0, width, height);
  const now = clockNow();
  rows.forEach((t, i) => {
    const x = (i % cols) * cell;
    const y = Math.floor(i / cols) * cell;
    const flashing = isFlashing(t.flashAt, now);
    g.fillStyle = flashing ? FLASH : COLORS[taskColor(t)];
    g.fillRect(x, y, cell - 1, cell - 1);
    if (t.contested && cell >= 6) {
      g.strokeStyle = COLORS.mismatch;
      g.lineWidth = 1;
      g.strokeRect(x + 0.5, y + 0.5, cell - 2, cell - 2);
    }
  });
}

// ---- rendering -------------------------------------------------------------------------------

let renderQueued = false;
function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render(latest);
  });
}

function onCluster(state: ClusterState): void {
  latest = state;
  tiles.sync(state);
  scheduleRender();
}

function setMachine(state: MachineState, detail?: string): void {
  machine = state;
  const label = detail ? `${state} · ${detail}` : state;
  els.machine.textContent = label;
  els.machine.className = `pill ${state === "live" ? "live" : state === "off" || state === "outdated" ? "off" : "wait"}`;
  if (state === "live") {
    els.banner.hidden = true;
    els.stage.hidden = false;
    els.table.hidden = false;
  } else {
    els.stage.hidden = true;
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
  for (const [button] of controlButtons) button.disabled = state !== "live";
  els.redundancy.disabled = state !== "live";
  scheduleRender();
}

const fmtMs = (ms: number | null): string => (ms === null ? "—" : `${ms} ms`);
const fmtTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

let tableRenderedAt = 0;
function render(state: ClusterState): void {
  const now = clockNow();
  const exec = state.execution;
  const prog = progress(state);
  els.gen.textContent = `gen ${state.generation ?? "—"}`;
  els.seq.textContent = `seq ${state.seq}`;
  els.counts.textContent = `${state.nodes.size} nodes · ${hostCount(state)} hosts`;
  els.exec.textContent = exec
    ? `${exec.programName} · ${exec.phase === "running" ? exec.stageName || `stage ${exec.stage}` : exec.phase} · ${prog.done}/${prog.total}`
    : "idle";
  els.exec.className = `pill ${exec?.phase === "failed" ? "off" : exec ? "live" : ""}`;
  els.rate.textContent = `${throughput(state, now).toFixed(1)} tasks/s`;

  // Notices: rotation, sleep, gaps in the story a visitor should hear about.
  const notices: string[] = [];
  if (state.rotation)
    notices.push(
      `Control plane rotating to generation ${state.rotation.next}; reconnecting in ${(state.rotation.reconnectAfterMs / 1000).toFixed(1)} s.`,
    );
  if (state.sleeping) notices.push(`The machine is going to sleep: ${state.sleeping}.`);
  if (state.machine && !state.machine.awake)
    notices.push(
      `The machine is asleep${state.machine.reason ? `: ${state.machine.reason}` : ""}.`,
    );
  els.notice.hidden = notices.length === 0;
  els.notice.textContent = notices.join(" ");

  // Execution row.
  if (exec) {
    els.execName.textContent = `${exec.programName} ${exec.executionId}${exec.human ? " · launched by a person" : ""}`;
    const plan = planTask(state);
    const detail =
      exec.phase === "failed"
        ? `failed: ${exec.failure ?? exec.status}`
        : exec.phase === "done"
          ? `done${exec.root ? ` · root ${exec.root.slice(0, 12)}…` : ""}${exec.followUp ? " · follow-up offered" : ""}`
          : exec.phase === "planning"
            ? `planning stage ${exec.stage}${plan ? ` on ${plan.holders.join(", ") || "…"}` : ""}`
            : exec.phase === "folding"
              ? `folding stage ${exec.stage}`
              : `stage ${exec.stage} ${exec.stageName} · ${exec.view}${exec.canvas ? ` ${exec.canvas.w}×${exec.canvas.h}` : ""}`;
    const budget = exec.budget
      ? ` · budget ${(exec.budget.used / 1000).toFixed(0)}/${(exec.budget.cap / 1000).toFixed(0)} s`
      : "";
    els.execDetail.textContent = detail + budget;
    els.execDetail.className = exec.phase === "failed" ? "bad" : "muted";
    els.progressFill.style.width = prog.total ? `${(100 * prog.done) / prog.total}%` : "0%";
    els.progressText.textContent = `${prog.done}/${prog.total}`;
    const c = exec.counters;
    els.counters.replaceChildren(
      ...(
        [
          ["pending", c.pending],
          ["assigned", c.assigned],
          ["done", c.done],
          ["failed", c.failed],
          ["reassigned", c.reassigned],
          ["speculated", c.speculated],
          ["verified", c.verified],
          ["mismatched", c.mismatched],
        ] as [string, number][]
      ).map(([label, value]) => {
        const chip = document.createElement("span");
        chip.className = `chip${value > 0 && (label === "failed" || label === "mismatched") ? " chip-bad" : ""}`;
        chip.dataset.counter = label;
        const num = document.createElement("b");
        num.textContent = String(value);
        chip.append(num, ` ${label}`);
        return chip;
      }),
    );
  } else {
    els.execName.textContent = "No execution";
    els.execDetail.textContent = state.queue.length
      ? "waiting for the queue"
      : "the machine idles until a program is queued";
    els.execDetail.className = "muted";
    els.progressFill.style.width = "0%";
    els.progressText.textContent = "";
    els.counters.replaceChildren();
  }
  const tilesView = exec?.view === "tiles";
  els.tiles.hidden = !tilesView;
  els.viewNote.hidden = tilesView || !exec;
  if (exec && !tilesView) {
    els.viewNote.textContent = `${exec.view} view: ${exec.root ? `result ${exec.root.slice(0, 16)}… is in the store` : "no result yet"}; the ${exec.view} renderer arrives with dashboard v2.`;
  }
  els.tileStats.textContent = tilesView
    ? `${tiles.paintedCount} painted · ${tiles.flags.size} refused · ${tiles.stats.inFlight} fetching`
    : "";
  if (tilesView) painter.present();
  drawGrid(state);

  // Controls reflect the machine.
  els.redundancy.checked = state.machine?.redundancy ?? false;

  // Queue and activity.
  els.queue.replaceChildren(
    ...state.queue.map((q) => {
      const li = document.createElement("li");
      li.textContent = `${q.programName} ${q.executionId}${q.human ? " · person" : ""}`;
      return li;
    }),
  );
  if (state.queue.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "empty";
    els.queue.appendChild(li);
  }
  els.activity.replaceChildren(
    ...state.activity
      .slice(-14)
      .reverse()
      .map((a) => {
        const li = document.createElement("li");
        li.className = `act act-${a.kind}`;
        const time = document.createElement("span");
        time.className = "muted";
        time.textContent = fmtTime(a.at);
        li.append(time, ` ${a.text}`);
        return li;
      }),
  );

  // The node table changes slowly; four times a second is plenty at 256 rows.
  if (now - tableRenderedAt >= 250 || state.nodes.size !== els.tbody.childElementCount) {
    tableRenderedAt = now;
    renderTable(state, now);
  }
}

function renderTable(state: ClusterState, now: number): void {
  const mineIds = new Set([...locals.values()].map((l) => l.status?.nodeId).filter(Boolean));
  const inFlight = inFlightByNode(state);
  const victims = state.victims && isFlashing(state.victims.at, now) ? state.victims : null;
  const rows = [...state.nodes.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  els.tbody.replaceChildren(
    ...rows.map((n) =>
      row(
        n,
        mineIds.has(n.nodeId),
        inFlight.get(n.nodeId) ?? 0,
        victims?.nodeIds.includes(n.nodeId) ?? false,
        victims?.op ?? "",
      ),
    ),
  );
}

function row(
  n: NodeView,
  mine: boolean,
  inFlight: number,
  hit: boolean,
  op: string,
): HTMLTableRowElement {
  const tr = document.createElement("tr");
  const cells = [
    n.nodeId + (mine ? " ★" : ""),
    n.hostId,
    n.kind,
    n.health,
    n.visible ? "yes" : "hidden",
    String(n.tasksDone),
    String(inFlight),
    fmtMs(n.lastTaskMs),
    fmtTime(n.joinedAt),
  ];
  cells.forEach((text, i) => {
    const td = document.createElement("td");
    td.textContent = text;
    if (i >= 5 && i <= 7) td.className = "num";
    if (i === 3) td.className = `health-${n.health}`;
    if (i === 0 && mine) td.className = "mine";
    tr.appendChild(td);
  });
  tr.dataset.nodeId = n.nodeId;
  if (hit) {
    tr.className = "hit";
    tr.title = op;
  }
  return tr;
}

function renderMine(): void {
  els.mine.replaceChildren(
    ...[...locals.values()].map((l) => {
      const div = document.createElement("div");
      div.className = "row";
      div.dataset.local = String(l.id);
      const label = document.createElement("span");
      const s = l.status;
      label.textContent = `${s?.nodeId ?? "…"} · ${s?.state ?? "starting"}${s?.detail ? ` · ${s.detail}` : ""}${s && s.tasksDone > 0 ? ` · ${s.tasksDone} done · ${fmtMs(s.lastTaskMs)}` : ""}`;
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
      ? demoMode
        ? "Demo mode: a scripted cluster inside this page; nothing is sent anywhere."
        : "Observe-only mode: this tab lends no CPU."
      : "No nodes in this tab.";
    els.mine.appendChild(p);
  }
}

// ---- local nodes -----------------------------------------------------------------------------

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
      tableRenderedAt = 0;
      scheduleRender();
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

// ---- controls --------------------------------------------------------------------------------

let client: ObserverClient | null = null;
let demo: DemoHandle | null = null;

function issue(control: ControlRequest): void {
  if (demo) {
    if (control.t === "setRedundancy") onCluster(withRedundancy(latest, control.on));
    demo.control(control);
    return;
  }
  if (!client?.send(control)) {
    els.notice.hidden = false;
    els.notice.textContent = "Not connected; the control was not sent.";
  }
}
for (const [button, control] of controlButtons) {
  button.onclick = () => {
    issue(control);
    button.disabled = true;
    setTimeout(() => {
      button.disabled = machine !== "live";
    }, 400);
  };
}
els.redundancy.onchange = () => issue({ t: "setRedundancy", on: els.redundancy.checked });

// Flashes fade and throughput decays even when the cluster is quiet.
setInterval(() => {
  if (machine === "live") scheduleRender();
}, 250);
window.addEventListener("resize", scheduleRender);

// ---- boot ------------------------------------------------------------------------------------

async function main(): Promise<void> {
  renderMine();
  if (demoMode) {
    setMachine("live", "demo");
    const pauseAtDone = Number(params.get("pause") ?? "0") || 0;
    const speed = Number(params.get("speed") ?? "1") || 1;
    demo = startDemo({
      apply: (msg) => onCluster(applyDemo(latest, msg)),
      store: demoStore,
      speed,
      pauseAtDone,
      clock: { now: () => demoTime, set: (ms) => (demoTime = ms) },
      onPause: () => {
        document.body.dataset.demoPaused = "1";
      },
    });
    expose();
    return;
  }
  setMachine("connecting");
  const config = (await (await fetch("/config.json", { cache: "no-store" })).json()) as {
    sessionUrl: string;
  };
  sessionUrl = new URL(config.sessionUrl, location.origin).toString();
  client = new ObserverClient(sessionUrl, {
    onState: setMachine,
    onCluster,
    onSession: (session) => {
      blobSource = storeSource(session.storeBase);
      if (!observeOnly && locals.size === 0 && !spawnedOnce) {
        spawnedOnce = true;
        spawn(1);
      }
    },
  });
  expose();
  await client.start();
}

// The demo drives the reducer directly with the page's clock.
function applyDemo(state: ClusterState, msg: Parameters<typeof applyMessage>[1]): ClusterState {
  return applyMessage(state, msg, clockNow());
}

function expose(): void {
  (window as unknown as { tabframe: unknown }).tabframe = {
    client,
    locals,
    hostId,
    tiles,
    demo,
    get state() {
      return latest;
    },
  };
}
let spawnedOnce = false;
void main();
