// The dashboard (design §3): the canvas is the hero — finished tiles land on it as they are
// verified, the scheduler's state is drawn over the rectangles still open — and around it the
// header, the panels, the flash log, the node table, and the nodes this tab lends. Everything the
// page shows is a render of the latest cluster state; `mountDashboard` wires the views and owns
// the state they share, and the entry decides what feeds it (a demo or an observer socket).
import { ActivityView, PulsesView } from "./activity-view.ts";
import { CanvasPainter, COLORS, drawGrid, taskAtGridClick, taskAtTileClick } from "./canvas.ts";
import { ThroughputChart } from "./chart.ts";
import { type ClusterState, emptyState } from "./cluster-state.ts";
import type { ControlRequest } from "./controls.ts";
import { LEGEND, machineSentence } from "./copy.ts";
import { $ } from "./dom.ts";
import { mountHeader, reasoned } from "./header.ts";
import { LocalNodes, renderLocalNodes } from "./local-nodes.ts";
import { NodesTable } from "./nodes-table.ts";
import { createNotice, type Notice } from "./notice.ts";
import type { MachineState } from "./observer.ts";
import { backLink, PANELS, type PageMode, panelLink } from "./page-mode.ts";
import { mountPanels, type Panels } from "./panels.ts";
import { isRunning } from "./selectors.ts";
import { type BlobSource, TileView } from "./tiles.ts";

/** The demo's virtual clock: the page renders with it, the script advances it. */
export interface Clock {
  now(): number;
  set(ms: number): void;
}

export interface Dashboard {
  readonly state: ClusterState;
  readonly hostId: string;
  readonly tiles: TileView;
  readonly panels: Panels;
  readonly locals: LocalNodes;
  readonly notice: Notice;
  readonly clock: Clock;
  onCluster(state: ClusterState): void;
  setMachine(state: MachineState, detail?: string): void;
  /** Where controls go once the page knows: the demo's handle, or the observer client. */
  setControls(send: (control: ControlRequest) => boolean): void;
  /** The store the panels and the tiles read from, once the session names it. */
  setStore(storeBase: string, blobs: BlobSource): void;
  setSessionUrl(url: string): void;
  openEditor(): Window | null;
  scheduleRender(): void;
}

export function mountDashboard(
  root: Document,
  mode: PageMode,
  demoStore: Map<string, Uint8Array>,
): Dashboard {
  if (mode.panel) {
    root.body.dataset.panel = mode.panel;
    for (const e of root.querySelectorAll<HTMLElement>(".panel-only")) e.hidden = false;
    root.getElementById(PANELS[mode.panel])?.classList.add("panel-full");
    root.title = `Tabframe · ${mode.panel}`;
  }
  const back = root.querySelector<HTMLAnchorElement>("#backToDashboard");
  if (back) back.href = backLink(location.search);
  for (const a of root.querySelectorAll<HTMLAnchorElement>("a.open-panel")) {
    const panel = new URL(a.href, location.origin).searchParams.get("panel") ?? "ledger";
    a.href = panelLink(location.search, panel, mode.demo);
  }

  const els = {
    notice: $<HTMLDivElement>("#notice", root),
    chart: $<HTMLCanvasElement>("#throughputChart", root),
    figure: $<HTMLSpanElement>("#throughputFigure", root),
    pulses: $<HTMLUListElement>("#pulses", root),
    tiles: $<HTMLCanvasElement>("#tiles", root),
    grid: $<HTMLCanvasElement>("#grid", root),
    legend: $<HTMLDivElement>("#legend", root),
    tbody: $<HTMLTableSectionElement>("#nodes tbody", root),
    activity: $<HTMLUListElement>("#activity", root),
    activitySummary: $<HTMLParagraphElement>("#activitySummary", root),
    mine: $<HTMLDivElement>("#mine", root),
    spawn1: $<HTMLButtonElement>("#spawn1", root),
    spawnN: $<HTMLButtonElement>("#spawnN", root),
    spawnCount: $<HTMLSpanElement>("#spawnCount", root),
    killMine: $<HTMLButtonElement>("#killMine", root),
    spawnHint: $<HTMLParagraphElement>("#spawnHint", root),
    redundancy: $<HTMLInputElement>("#redundancy", root),
    tileStats: $<HTMLSpanElement>("#tileStats", root),
    openEditor: $<HTMLButtonElement>("#openEditor", root),
    restart: $<HTMLButtonElement>("#restart", root),
    skip: $<HTMLButtonElement>("#skip", root),
    freeze: $<HTMLButtonElement>("#freezePanel", root),
  };
  const controlButtons: [HTMLButtonElement, ControlRequest][] = [
    [$<HTMLButtonElement>("#stop", root), { t: "stop" }],
    [$<HTMLButtonElement>("#start", root), { t: "start" }],
    [$<HTMLButtonElement>("#resume", root), { t: "resume" }],
    [$<HTMLButtonElement>("#killHalf", root), { t: "killHalf" }],
    [$<HTMLButtonElement>("#freezeHalf", root), { t: "freezeHalf" }],
    [$<HTMLButtonElement>("#throttleHalf", root), { t: "throttleHalf" }],
    [$<HTMLButtonElement>("#resumeAll", root), { t: "resumeAll" }],
    [els.restart, { t: "restart" }],
    [els.skip, { t: "skip" }],
  ];

  const hostId = crypto.randomUUID().slice(0, 8);
  const threads = navigator.hardwareConcurrency || 1;
  const spawnDefault = Math.max(1, threads - 1);
  els.spawnCount.textContent = String(spawnDefault);
  els.spawnHint.dataset.cores = String(threads);
  els.spawnHint.dataset.default = String(spawnDefault);
  els.spawnHint.textContent = `This browser reports ${threads} CPU ${threads === 1 ? "thread" : "threads"}; spawn ${spawnDefault} keeps one for the page. Nodes in this tab share those CPU threads, so spawning more than ${spawnDefault} only slices them thinner — another tab on another device adds real ones.`;
  els.spawnN.title = `Spawn ${spawnDefault} nodes: one per CPU thread this browser reports, minus one for the page`;
  if (mode.observeOnly && !mode.demo) {
    // An observer lends no cores (rule R3): the spawn controls stay, greyed, and say why.
    els.spawnHint.textContent =
      "Observing: this tab lends no cores. Open the plain address (without ?observe) to lend some.";
    for (const b of [els.spawn1, els.spawnN, els.killMine]) {
      b.disabled = true;
      b.title = `${b.title} — an observer lends no cores; open the plain address to lend some`;
    }
  }
  if (mode.demo) {
    // A real node here would try to reach a machine that does not exist and say "connecting" for ever.
    els.spawnHint.textContent =
      "Demo: the nodes are scripted inside this page; open the live address to lend real cores.";
    for (const b of [els.spawn1, els.spawnN, els.killMine]) {
      b.disabled = true;
      b.title = `${b.title} — the demo's nodes are scripted; open the live address to lend cores`;
    }
  }
  els.legend.replaceChildren(
    ...LEGEND.map(([key, label]) => {
      const item = root.createElement("span");
      item.className = "legend-item";
      item.dataset.state = key;
      const swatch = root.createElement("i");
      swatch.className = `swatch swatch-${key}`;
      if (key !== "flash" && key !== "contested") swatch.style.background = COLORS[key];
      item.append(swatch, label);
      return item;
    }),
  );

  let latest: ClusterState = emptyState();
  let demoTime = Date.now();
  const clock: Clock = {
    now: () => (mode.demo ? demoTime : Date.now()),
    set: (ms) => {
      demoTime = ms;
    },
  };
  let sessionUrl = "";
  let storeBase: string | null = null;
  let blobSource: BlobSource = {
    async get(hash) {
      return demoStore.get(hash) ?? null;
    },
  };
  let controls: ((control: ControlRequest) => boolean) | null = null;

  let renderQueued = false;
  function scheduleRender(): void {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render(latest);
    });
  }

  const notice = createNotice(scheduleRender);
  const header = mountHeader(root, {
    controls: controlButtons.map(([button]) => button),
    redundancy: els.redundancy,
    rerender: scheduleRender,
  });
  const panels: Panels = mountPanels(root, {
    panelMode: mode.panel,
    openFile: mode.openFile,
    openRoot: mode.openRoot,
    blobs: () => blobSource,
    storeBase: () => storeBase,
    send: issue,
    rerender: scheduleRender,
    now: clock.now,
  });
  const canvasDeps = {
    state: () => latest,
    selectedTask: () => panels.selectedTask,
    now: clock.now,
  };
  const painter = new CanvasPainter(els.tiles, canvasDeps);
  const tiles = new TileView({ get: (h) => blobSource.get(h) }, painter);
  tiles.onChange = () => scheduleRender();
  const chart = new ThroughputChart(els.chart, els.figure);
  const pulses = new PulsesView(els.pulses);
  const activity = new ActivityView(els.activity, els.activitySummary, mode.panel === "activity");
  const table = new NodesTable(els.tbody);
  const locals = new LocalNodes({
    sessionUrl: () => sessionUrl,
    hostId,
    onChange: () => {
      renderMine();
      table.invalidate();
      scheduleRender();
    },
    onStatus: (status) => {
      if (status.state === "outdated") header.setMachine("outdated");
    },
  });

  function renderMine(): void {
    renderLocalNodes(
      els.mine,
      locals,
      mode.observeOnly
        ? mode.demo
          ? "Demo mode: a scripted cluster inside this page; nothing is sent anywhere."
          : "Observe-only mode: this tab lends no CPU."
        : "No nodes in this tab.",
    );
  }

  /** A click on the grid or the canvas selects the task under it; a second click on the same one clears it. */
  const toggleTask = (taskId: string | undefined): void =>
    panels.selectTask(taskId !== undefined && taskId !== panels.selectedTask ? taskId : null);
  els.grid.addEventListener("click", (ev) =>
    toggleTask(taskAtGridClick(els.grid, latest, ev)?.taskId),
  );
  els.tiles.addEventListener("click", (ev) =>
    toggleTask(taskAtTileClick(els.tiles, latest, ev)?.taskId),
  );

  function onCluster(state: ClusterState): void {
    latest = state;
    tiles.sync(state);
    scheduleRender();
  }

  /** Send a control to whatever control plane this page is watching; false when there is none. */
  function issue(control: ControlRequest): boolean {
    const sent = controls?.(control) ?? false;
    if (!sent) {
      notice.show("Not connected; the control was not sent.", 4_000);
      scheduleRender();
    }
    return sent;
  }
  for (const [button, control] of controlButtons) {
    button.onclick = () => {
      notice.issued();
      issue(control);
      button.disabled = true;
      setTimeout(() => {
        button.disabled = header.machine !== "live";
      }, 400);
    };
  }
  els.redundancy.onchange = () => issue({ t: "setRedundancy", on: els.redundancy.checked });
  els.spawn1.onclick = () => locals.spawn(1);
  els.spawnN.onclick = () => locals.spawn(spawnDefault);
  els.killMine.onclick = () => locals.closeAll();

  // A panel tab can pause its own updates so a reader can inspect it; the count on the button is
  // of states that arrived while frozen, not of frames rendered.
  const freeze = { on: false, missed: 0, seenSeq: null as number | null };
  els.freeze.onclick = () => {
    freeze.on = !freeze.on;
    freeze.seenSeq = null;
    if (!freeze.on) freeze.missed = 0;
    els.freeze.textContent = freeze.on ? "resume updates" : "pause updates";
    els.freeze.dataset.frozen = freeze.on ? "1" : "0";
    scheduleRender();
  };

  /** The editor lives in its own tab, which holds the machine paused while it is open; a named target reuses it. */
  function openEditor(): Window | null {
    return window.open(mode.demo ? "/editor.html?demo=1" : "/editor.html", "tabframe-editor");
  }
  els.openEditor.onclick = () => void openEditor();

  function render(state: ClusterState): void {
    const now = clock.now();
    header.render(state, now);
    notice.echo(state);
    // The status line: a control's echo for a few seconds, else the sentence of state (rule R1).
    const sentence = machineSentence(state, {
      live: header.machine === "live",
      demo: mode.demo,
      observe: mode.observeOnly && !mode.demo && mode.panel === null,
    });
    const said = notice.current ?? sentence;
    els.notice.hidden = said === null;
    els.notice.textContent = said ?? "";
    els.notice.classList.toggle("sentence", notice.current === null);
    // Restart and skip need something running; they stay where they are and say why (rule R3).
    const running = isRunning(state);
    for (const b of [els.restart, els.skip]) {
      b.disabled = header.machine !== "live" || !running;
      b.title = reasoned(
        b,
        header.machine !== "live" ? "not connected yet" : running ? null : "nothing is running",
      );
    }
    chart.render(state, now);
    const tilesView = state.execution?.view === "tiles";
    els.tiles.hidden = !tilesView;
    els.tileStats.textContent = tilesView
      ? `${tiles.paintedCount} painted · ${tiles.flags.size} refused · ${tiles.stats.inFlight} fetching`
      : "";
    if (tilesView) painter.present();
    drawGrid(els.grid, state, canvasDeps);
    pulses.render(state, now);
    els.redundancy.checked = state.machine?.redundancy ?? false;

    // A frozen panel tab keeps what it shows; the count of updates it is holding back is on the button.
    if (mode.panel && freeze.on) {
      if (freeze.seenSeq === null) {
        freeze.seenSeq = state.seq; // the state on screen at the freeze is not "held"
      } else if (state.seq !== freeze.seenSeq) {
        freeze.seenSeq = state.seq;
        freeze.missed++;
      }
      els.freeze.textContent = `resume updates (${freeze.missed} held)`;
      return;
    }
    panels.render(state);
    activity.render(state, now);
    table.render(state, now, locals.nodeIds());
  }

  // Flashes fade and throughput decays even when the cluster is quiet.
  setInterval(() => {
    if (header.machine === "live") scheduleRender();
  }, 250);
  window.addEventListener("resize", scheduleRender);
  renderMine();

  return {
    get state() {
      return latest;
    },
    hostId,
    tiles,
    panels,
    locals,
    notice,
    clock,
    onCluster,
    setMachine: header.setMachine,
    setControls(send) {
      controls = send;
    },
    setStore(base, blobs) {
      storeBase = base;
      blobSource = blobs;
    },
    setSessionUrl(url) {
      sessionUrl = url;
    },
    openEditor,
    scheduleRender,
  };
}
