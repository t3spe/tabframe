// The host page (design §3): one observer socket for the dashboard, zero or more node workers.
// The canvas is the hero: finished tiles land on it as they are verified, and the scheduler's
// state is drawn over the rectangles that are still open. Around it, the panels of dashboard v2:
// programs, queue, the stage strip, the result of a bars or text program, files, task detail, the
// ledger; and the polish of WP4.1: flashes with a log of what just moved, a legend, the rotation
// and sleep banners, a throughput chart, and a spawn hint sized to this browser's cores.
import type { HostToWorker, WorkerToHost } from "@tabframe/node/platform/web";
import type { NodeView, PlaceView } from "@tabframe/protocol";
import { connectionCopy, fmtCountdown, machineCopy, ROTATING_DETAIL } from "./banners.ts";
import { DEMO_CYCLE, type DemoHandle, type DemoProgram, startDemo } from "./demo.ts";
import { type ControlRequest, type MachineState, ObserverClient } from "./observer.ts";
import { gridIndexAt, gridLayout, mountPanels, type Panels } from "./panels.ts";
import {
  applyMessage,
  type ClusterState,
  emptyState,
  headerSlot,
  hostCount,
  inFlightByNode,
  isFlashing,
  isRunning,
  loopLabel,
  loopState,
  machineBanner,
  machineSentence,
  type Pulse,
  planTask,
  progress,
  stageTasks,
  stopTitle,
  TASK_COLOR_LABELS,
  type TaskColor,
  taskColor,
  throughput,
  throughputSeries,
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
  released: "#e69f00",
  done: "#009e73",
  verified: "#0072b2",
  mismatch: "#f0e442",
  failed: "#d55e00",
};
/** The legend: every task colour, then the two overlays the grid draws on top of them. */
const LEGEND: [TaskColor | "flash" | "contested", string][] = [
  ...TASK_COLOR_LABELS,
  ["flash", "flash: just taken back, twinned, verified, or retracted"],
  ["contested", "contested: results disagreed"],
];
/** What a flash says in the pulse list. */
const PULSE_TEXT: Record<Pulse["kind"], (p: Pulse) => string> = {
  released: (p) => `${p.taskId} taken back from ${p.nodeId}`,
  speculated: (p) => `${p.taskId} twin on ${p.nodeId}`,
  verified: (p) => `${p.taskId} verified by ${p.nodeId}`,
  mismatch: (p) => `${p.taskId} results disagree, ${p.nodeId} retracted`,
};
const FLASH = "#ffffff";
const SELECTED = "#6ea8ff";
const BG = "#0b0d10";

const params = new URLSearchParams(location.search);
const demoMode = params.has("demo");
/** One big panel, full-width, in its own tab (WP6.3): ledger, files, or activity. */
const PANELS = { ledger: "ledgerPanel", files: "filesPanel", activity: "activityPanel" } as const;
const panelMode = ((p) => (p && p in PANELS ? (p as keyof typeof PANELS) : null))(
  params.get("panel"),
);
if (panelMode) {
  document.body.dataset.panel = panelMode;
  document.getElementById(PANELS[panelMode])?.classList.add("panel-full");
  document.title = `Tabframe · ${panelMode}`;
}
const observeOnly = params.has("observe") || demoMode || panelMode !== null;
// A panel tab's way back (WP7.7, rule R7): the dashboard with this page's own query, minus the panel's.
{
  const back = document.querySelector<HTMLAnchorElement>("#backToDashboard");
  if (back) {
    const q = new URLSearchParams(location.search);
    for (const k of ["panel", "root", "file", "path", "size"]) q.delete(k);
    const query = q.toString();
    back.href = query ? `/?${query}` : "/";
  }
}
// The panels' "open ↗" links carry the page's own query, so a demo opens the same demo and a live
// page opens an observer; only the panel differs (WP6.3, WP6.8).
for (const a of document.querySelectorAll<HTMLAnchorElement>("a.open-panel")) {
  const q = new URLSearchParams(location.search);
  for (const k of ["root", "file", "path", "size"]) q.delete(k);
  if (!demoMode) q.set("observe", "");
  q.set("panel", new URL(a.href, location.origin).searchParams.get("panel") ?? "ledger");
  a.href = `/?${q.toString()}`;
}
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
  nextRotation: $<HTMLSpanElement>("#nextRotation"),
  notice: $<HTMLDivElement>("#notice"),
  machineBanner: $<HTMLDivElement>("#machineBanner"),
  banner: $<HTMLDivElement>("#banner"),
  bannerTitle: $<HTMLElement>("#bannerTitle"),
  bannerBody: $<HTMLSpanElement>("#bannerBody"),
  bannerHint: $<HTMLSpanElement>("#bannerHint"),
  loop: $<HTMLSpanElement>("#loop"),
  chart: $<HTMLCanvasElement>("#throughputChart"),
  figure: $<HTMLSpanElement>("#throughputFigure"),
  pulses: $<HTMLUListElement>("#pulses"),
  stage: $<HTMLDivElement>("#stage"),
  execName: $<HTMLSpanElement>("#execName"),
  execDetail: $<HTMLSpanElement>("#execDetail"),
  progressFill: $<HTMLDivElement>("#progressFill"),
  progressText: $<HTMLSpanElement>("#progressText"),
  tiles: $<HTMLCanvasElement>("#tiles"),
  grid: $<HTMLCanvasElement>("#grid"),
  legend: $<HTMLDivElement>("#legend"),
  counters: $<HTMLDivElement>("#counters"),
  table: $<HTMLTableElement>("#nodes"),
  tbody: $<HTMLTableSectionElement>("#nodes tbody"),
  activity: $<HTMLUListElement>("#activity"),
  mine: $<HTMLDivElement>("#mine"),
  spawn1: $<HTMLButtonElement>("#spawn1"),
  spawnN: $<HTMLButtonElement>("#spawnN"),
  spawnCount: $<HTMLSpanElement>("#spawnCount"),
  killMine: $<HTMLButtonElement>("#killMine"),
  spawnHint: $<HTMLParagraphElement>("#spawnHint"),
  redundancy: $<HTMLInputElement>("#redundancy"),
  tileStats: $<HTMLSpanElement>("#tileStats"),
  openEditor: $<HTMLButtonElement>("#openEditor"),
};
const controlButtons: [HTMLButtonElement, ControlRequest][] = [
  [$<HTMLButtonElement>("#stop"), { t: "stop" }],
  [$<HTMLButtonElement>("#start"), { t: "start" }],
  [$<HTMLButtonElement>("#resume"), { t: "resume" }],
  [$<HTMLButtonElement>("#killHalf"), { t: "killHalf" }],
  [$<HTMLButtonElement>("#freezeHalf"), { t: "freezeHalf" }],
  [$<HTMLButtonElement>("#throttleHalf"), { t: "throttleHalf" }],
  [$<HTMLButtonElement>("#resumeAll"), { t: "resumeAll" }],
  [$<HTMLButtonElement>("#restart"), { t: "restart" }],
  [$<HTMLButtonElement>("#skip"), { t: "skip" }],
];

const spawnDefault = Math.max(1, cores - 1);
els.spawnCount.textContent = String(spawnDefault);
els.spawnHint.dataset.cores = String(cores);
els.spawnHint.dataset.default = String(spawnDefault);
els.spawnHint.textContent = `This browser reports ${cores} ${cores === 1 ? "core" : "cores"}; spawn ${spawnDefault} keeps one for the page. Nodes in this tab share those cores, so spawning more than ${spawnDefault} only slices them thinner — another tab on another device adds real ones.`;
els.spawnN.title = `Spawn ${spawnDefault} nodes: one per core this browser reports, minus one for the page`;
if (observeOnly && !demoMode) {
  // An observer lends no cores (WP7.7, rule R3): the spawn controls stay, greyed, and say why.
  els.spawnHint.textContent =
    "Observing: this tab lends no cores. Open the plain address (without ?observe) to lend some.";
  for (const b of [els.spawn1, els.spawnN, els.killMine]) {
    b.disabled = true;
    b.title = `${b.title} — an observer lends no cores; open the plain address to lend some`;
  }
}
els.legend.replaceChildren(
  ...LEGEND.map(([key, label]) => {
    const item = document.createElement("span");
    item.className = "legend-item";
    item.dataset.state = key;
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
      if (t.taskId === panels.selectedTask) {
        d.strokeStyle = SELECTED;
        d.lineWidth = 3;
        d.strokeRect(x * s + 1.5, y * s + 1.5, w * s - 3, h * s - 3);
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
  const { cell, cols, lines } = gridLayout(n, width);
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
    if (t.taskId === panels.selectedTask) {
      g.strokeStyle = SELECTED;
      g.lineWidth = 2;
      g.strokeRect(x + 1, y + 1, cell - 3, cell - 3);
    }
  });
}

/** A click on the grid selects the task under it; a second click on the same cell clears it. */
els.grid.addEventListener("click", (ev) => {
  const rows = stageTasks(latest);
  const rect = els.grid.getBoundingClientRect();
  const scale = els.grid.width / Math.max(1, rect.width);
  const x = (ev.clientX - rect.left) * scale;
  const y = (ev.clientY - rect.top) * scale;
  const index = gridIndexAt(rows.length, els.grid.width, x, y);
  const task = index >= 0 ? rows[index] : undefined;
  panels.selectTask(task && task.taskId !== panels.selectedTask ? task.taskId : null);
});
/** A click on the canvas selects the tile under it. */
els.tiles.addEventListener("click", (ev) => {
  const exec = latest.execution;
  if (!exec?.canvas) return;
  const rect = els.tiles.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * exec.canvas.w;
  const y = ((ev.clientY - rect.top) / Math.max(1, rect.height)) * exec.canvas.h;
  const task = stageTasks(latest).find(
    (t) =>
      t.place &&
      x >= t.place.x &&
      x < t.place.x + t.place.w &&
      y >= t.place.y &&
      y < t.place.y + t.place.h,
  );
  panels.selectTask(task && task.taskId !== panels.selectedTask ? task.taskId : null);
});

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

const clusterListeners = new Set<(state: ClusterState) => void>();
function onCluster(state: ClusterState): void {
  latest = state;
  tiles.sync(state);
  scheduleRender();
  for (const listener of clusterListeners) listener(state);
}

function setMachine(state: MachineState, detail?: string): void {
  machine = state;
  const label = detail ? `${state} · ${detail}` : state;
  els.machine.textContent = label;
  els.machine.className = `pill ${state === "live" ? "live" : state === "off" || state === "outdated" ? "off" : "wait"}`;
  els.banner.dataset.state = state;
  if (state === "live") {
    els.banner.hidden = true;
    els.stage.hidden = false;
    els.table.hidden = false;
  } else {
    // A reconnect after a rotation keeps the picture: the render continues on the new generation.
    const rotating = state === "connecting" && detail === ROTATING_DETAIL;
    els.stage.hidden = !rotating;
    els.table.hidden = !rotating;
    els.banner.hidden = false;
    const copy = connectionCopy(state, detail);
    els.bannerTitle.textContent = copy.title;
    els.bannerBody.textContent = copy.body;
    els.bannerHint.textContent = copy.hint;
    if (state === "outdated") setTimeout(() => location.reload(), 1_500);
  }
  for (const [button] of controlButtons) {
    button.disabled = state !== "live";
    button.title = reasoned(button, state === "live" ? null : "not connected yet");
  }
  els.redundancy.disabled = state !== "live";
  scheduleRender();
}

/** A control's tooltip: what it does, and — when it cannot apply now — why (WP7.7, rule R3). */
function reasoned(el: HTMLElement, reason: string | null): string {
  if (!el.dataset.baseTitle) el.dataset.baseTitle = el.title;
  return reason ? `${el.dataset.baseTitle} — ${reason}` : el.dataset.baseTitle;
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
  // The execution pill is about the execution; the loop pill is about the loop (WP7.1).
  els.exec.textContent = exec
    ? `${exec.programName} · ${exec.phase === "running" ? exec.stageName || `stage ${exec.stage}` : exec.phase} · ${prog.done}/${prog.total}`
    : "idle";
  els.exec.className = `pill ${exec?.phase === "failed" ? "off" : exec ? "live" : ""}`;
  const loop = loopState(state);
  els.loop.textContent = loopLabel(state);
  els.loop.dataset.loop = loop;
  els.loop.title =
    loop === "running"
      ? "The automatic loop renders frame after frame while someone watches"
      : loop === "held"
        ? "A person pressed Stop: the loop launches nothing until Start; a launch of yours still runs at once"
        : loop === "yielded"
          ? "Your launch ended: the result stays on the stage until Start or ten quiet minutes"
          : "An editor tab holds the machine: in-flight tasks finish, nothing new starts; closing it or launching resumes";
  // The header's one slot means "what you can do to the machine right now" (WP7.1, rule R3).
  const slot = headerSlot(state);
  $<HTMLButtonElement>("#stop").hidden = slot !== "stop";
  $<HTMLButtonElement>("#start").hidden = slot !== "start";
  $<HTMLButtonElement>("#resume").hidden = slot !== "resume";
  $<HTMLButtonElement>("#stop").title = stopTitle(state);
  noticeOwnControl(state);
  els.rate.textContent = `${throughput(state, now).toFixed(1)} tasks/s`;
  const due = state.machine?.nextRotationAt ?? null;
  els.nextRotation.hidden = due === null;
  if (due !== null) {
    const minutes = Math.ceil((due - now) / 60_000);
    els.nextRotation.textContent = minutes > 0 ? `rotation in ${minutes} min` : "rotation due";
  }

  // The banner over the stage: a rotation with its countdown, the machine going to or being asleep.
  renderMachineBanner(state, now);
  renderChart(state, now);
  // The status line: a control's echo for a few seconds, else the sentence of state (WP7.7, R1).
  const sentence = machineSentence(state, {
    live: machine === "live",
    demo: demoMode,
    observe: observeOnly && !demoMode && panelMode === null,
  });
  const said = transientNotice ?? sentence;
  els.notice.hidden = said === null;
  els.notice.textContent = said ?? "";
  els.notice.classList.toggle("sentence", transientNotice === null);
  // Restart and skip need something running; they stay where they are and say why (R3).
  const running = isRunning(state);
  for (const id of ["#restart", "#skip"]) {
    const b = $<HTMLButtonElement>(id);
    b.disabled = machine !== "live" || !running;
    b.title = reasoned(
      b,
      machine !== "live" ? "not connected yet" : running ? null : "nothing is running",
    );
  }

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
    // The counters keep their slots while nothing runs (WP6.2): eight chips, dashes for numbers.
    els.counters.replaceChildren(
      ...[
        "pending",
        "assigned",
        "done",
        "failed",
        "reassigned",
        "speculated",
        "verified",
        "mismatched",
      ].map((label) => {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.dataset.counter = label;
        const num = document.createElement("b");
        num.textContent = "—";
        chip.append(num, ` ${label}`);
        return chip;
      }),
    );
  }
  const tilesView = exec?.view === "tiles";
  els.tiles.hidden = !tilesView;
  els.tileStats.textContent = tilesView
    ? `${tiles.paintedCount} painted · ${tiles.flags.size} refused · ${tiles.stats.inFlight} fetching`
    : "";
  if (tilesView) painter.present();
  drawGrid(state);
  renderPulses(state, now);

  // Controls reflect the machine.
  els.redundancy.checked = state.machine?.redundancy ?? false;

  // The panels: programs, queue, strip, failure, result, files, task detail. A frozen panel tab
  // keeps what it shows; the count of updates it is holding back is on the button (WP6.8).
  if (panelMode && panelFrozen) {
    panelFrozenMissed++;
    freezeButton.textContent = `resume updates (${panelFrozenMissed} held)`;
    return;
  }
  panels.render(state);

  const lastAct = state.activity.at(-1);
  $<HTMLParagraphElement>("#activitySummary").textContent = lastAct
    ? `${state.activity.length} lines · last: ${fmtTime(lastAct.at)} ${lastAct.text}`
    : "nothing yet";
  els.activity.replaceChildren(
    ...state.activity
      .slice(panelMode === "activity" ? 0 : -14)
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

function renderMachineBanner(state: ClusterState, now: number): void {
  const banner = machineBanner(state, now);
  const box = els.machineBanner;
  box.hidden = !banner;
  if (!banner) {
    box.replaceChildren();
    delete box.dataset.kind;
    delete box.dataset.next;
    return;
  }
  const copy = machineCopy(banner);
  box.dataset.kind = banner.kind;
  const title = document.createElement("strong");
  const body = document.createElement("span");
  const hint = document.createElement("span");
  hint.className = "muted";
  if (banner.kind === "rotating") {
    box.dataset.next = String(banner.next);
    const gen = document.createElement("b");
    gen.id = "rotationGeneration";
    gen.textContent = String(banner.next);
    title.append("Control plane rotating to generation ", gen, ".");
    const countdown = document.createElement("b");
    countdown.id = "rotationCountdown";
    countdown.textContent = fmtCountdown(banner.msLeft);
    body.append(" Reconnecting in ", countdown, `. ${copy.body}`);
  } else {
    delete box.dataset.next;
    title.textContent = copy.title;
    body.textContent = ` ${copy.body}`;
  }
  hint.textContent = ` ${copy.hint}`;
  box.replaceChildren(title, body, hint);
}

/** Round up to 1, 2, or 5 times a power of ten: a scale a reader can name. */
export function niceCeil(x: number): number {
  if (x <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  const m = x / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

let chartScale = 1;
let chartScaleAt = 0;
/**
 * Tasks done per second over the last minute as one quiet area line (WP7.2): drawn at the screen's
 * pixel density, on a scale that rises at once to a round number above the peak and comes down
 * only after a minute below half of it, with a caption that says what the picture is. The figure
 * beside it names the rate and the cluster.
 */
function renderChart(state: ClusterState, now: number): void {
  const full = throughputSeries(state, now);
  const series = full.slice(0, -1); // the current second is still filling; it would always dip
  const c = els.chart;
  const dpr = window.devicePixelRatio || 1;
  const cssW = c.clientWidth || 240;
  const cssH = c.clientHeight || 36;
  const w = Math.round(cssW * dpr);
  const h = Math.round(cssH * dpr);
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = BG;
  g.fillRect(0, 0, cssW, cssH);
  const peak = Math.max(0, ...series);
  if (peak > chartScale) {
    chartScale = niceCeil(peak);
    chartScaleAt = now;
  } else if (peak < chartScale / 2 && now - chartScaleAt > 60_000) {
    chartScale = niceCeil(peak);
    chartScaleAt = now;
  }
  const baseY = cssH - 1.5;
  const top = 13; // room for the caption
  const y = (v: number): number => baseY - ((baseY - top) * Math.min(v, chartScale)) / chartScale;
  const stepX = cssW / Math.max(1, series.length - 1);
  g.strokeStyle = "#232a33";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, baseY + 0.5);
  g.lineTo(cssW, baseY + 0.5);
  g.stroke();
  if (series.some((v) => v > 0)) {
    g.beginPath();
    g.moveTo(0, baseY);
    for (const [i, v] of series.entries()) g.lineTo(i * stepX, y(v));
    g.lineTo((series.length - 1) * stepX, baseY);
    g.closePath();
    g.fillStyle = "rgba(110, 168, 255, 0.18)";
    g.fill();
    g.beginPath();
    for (const [i, v] of series.entries()) {
      if (i === 0) g.moveTo(0, y(v));
      else g.lineTo(i * stepX, y(v));
    }
    g.strokeStyle = "#6ea8ff";
    g.lineWidth = 1.25;
    g.lineJoin = "round";
    g.stroke();
  }
  const unit = state.execution?.view === "tiles" ? "tiles" : "tasks";
  g.fillStyle = "#7d8794";
  g.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  g.textBaseline = "top";
  g.fillText(`last 60 s · peak ${peak} ${unit}/s · scale ${chartScale}`, 4, 2);
  const rate = throughput(state, now);
  els.figure.textContent = `${rate.toFixed(1)} ${unit}/s · ${state.nodes.size} nodes`;
  els.figure.dataset.rate = rate.toFixed(1);
  els.figure.dataset.nodes = String(state.nodes.size);
  els.figure.dataset.peak = String(peak);
  c.dataset.scale = String(chartScale);
  c.title = `${unit} done per second over the last minute, one line; the scale (${chartScale}/s) moves at most once a minute`;
}

let pulsesDrawn = "";
/** The last flashes as words, newest first; a row that is still flashing is marked live. */
function renderPulses(state: ClusterState, now: number): void {
  const rows = state.pulses.slice(-6).reverse();
  const sig = rows.map((p) => `${p.seq}:${p.taskId}:${isFlashing(p.at, now)}`).join(" ");
  if (sig === pulsesDrawn) return;
  pulsesDrawn = sig;
  els.pulses.hidden = rows.length === 0;
  els.pulses.replaceChildren(
    ...rows.map((p) => {
      const li = document.createElement("li");
      li.className = `pulse pulse-${p.kind}${isFlashing(p.at, now) ? " pulse-live" : ""}`;
      li.dataset.kind = p.kind;
      li.dataset.task = p.taskId;
      const time = document.createElement("span");
      time.className = "muted";
      time.textContent = fmtTime(p.at);
      li.append(time, ` ${PULSE_TEXT[p.kind](p)}`);
      return li;
    }),
  );
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
/** A short-lived line under the header: a control that could not be sent. */
let transientNotice: string | null = null;
let transientTimer: ReturnType<typeof setTimeout> | null = null;

/** Send a control to whatever control plane this page is watching; false when there is none. */
function issue(control: ControlRequest): boolean {
  if (demo) {
    if (control.t === "setRedundancy") onCluster(withRedundancy(latest, control.on));
    demo.control(control);
    return true;
  }
  const sent = client?.send(control) ?? false;
  if (!sent) {
    transientNotice = "Not connected; the control was not sent.";
    if (transientTimer) clearTimeout(transientTimer);
    transientTimer = setTimeout(() => {
      transientNotice = null;
      scheduleRender();
    }, 4_000);
    scheduleRender();
  }
  return sent;
}
/**
 * What a control did, said back (WP7.1, rule R2): when a control this page issued in the last ten
 * seconds is echoed by the machine, its activity line shows in the notice for a few seconds.
 */
let issuedAt = 0;
let noticedSeq = 0;
function noticeOwnControl(state: ClusterState): void {
  if (Date.now() - issuedAt > 10_000) return;
  const last = state.activity.at(-1);
  if (!last || last.kind !== "control" || last.seq <= noticedSeq) return;
  noticedSeq = last.seq;
  transientNotice = last.text;
  if (transientTimer) clearTimeout(transientTimer);
  transientTimer = setTimeout(() => {
    transientNotice = null;
    scheduleRender();
  }, 5_000);
}
for (const [button, control] of controlButtons) {
  button.onclick = () => {
    issuedAt = Date.now();
    issue(control);
    button.disabled = true;
    setTimeout(() => {
      button.disabled = machine !== "live";
    }, 400);
  };
}
els.redundancy.onchange = () => issue({ t: "setRedundancy", on: els.redundancy.checked });

/** The files tab can open with a file and a root pinned by its query (WP6.8). */
const openFile =
  panelMode === "files" && params.get("file") && params.get("path")
    ? {
        hash: params.get("file") as string,
        path: params.get("path") as string,
        size: Number(params.get("size") ?? "0") || 0,
      }
    : null;
const openRoot = panelMode === "files" ? params.get("root") : null;
/** A panel tab can pause its own updates so a reader can inspect it (WP6.8). */
let panelFrozen = false;
let panelFrozenMissed = 0;
const freezeButton = $<HTMLButtonElement>("#freezePanel");
freezeButton.onclick = () => {
  panelFrozen = !panelFrozen;
  if (!panelFrozen) panelFrozenMissed = 0;
  freezeButton.textContent = panelFrozen ? "resume updates" : "pause updates";
  freezeButton.dataset.frozen = panelFrozen ? "1" : "0";
  scheduleRender();
};

const panels: Panels = mountPanels(document, {
  panelMode,
  openFile,
  openRoot,
  blobs: () => blobSource,
  storeBase: () => storeBase,
  send: issue,
  rerender: scheduleRender,
  now: clockNow,
});

// ---- the editor (design §5.6) lives in its own tab since WP6.4 ------------------------------
// The tab holds the machine paused while it is open; launching or closing resumes it. A named
// target reuses the tab if it is already open.

let storeBase: string | null = null;

function openEditor(): Window | null {
  return window.open(demoMode ? "/editor.html?demo=1" : "/editor.html", "tabframe-editor");
}
els.openEditor.onclick = () => void openEditor();

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
      ...(isDemoProgram(params.get("program"))
        ? { startWith: params.get("program") as DemoProgram }
        : {}),
      holdAfterFirst: params.has("hold"),
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
      storeBase = session.storeBase;
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

const isDemoProgram = (name: string | null): boolean =>
  name !== null && (DEMO_CYCLE as readonly string[]).includes(name);

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
    panels,
    get state() {
      return latest;
    },
    openEditor,
  };
}
let spawnedOnce = false;
void main();
