// Dashboard v2 panels (design §5.1, §6.7, §8.3): programs, queue, the stage strip, the result of
// a `bars` or `text` program, the files behind an execution's root, a task's detail, the ledger
// of settled tasks (hashes and where their bytes live), and failure surfacing. The state comes from `state.ts`; bytes come from the store by hash; controls go back
// through the observer socket. No framework: each panel is a render function over the state that
// rebuilds its DOM only when what it shows has changed, so buttons stay put under a finger.
import type { ControlRequest } from "./observer.ts";
import {
  barRows,
  type FileEntry,
  finalOutput,
  fmtBytes,
  fmtValue,
  groupFiles,
  listFiles,
  type Preview,
  parseManifest,
  previewOf,
  readBars,
  TEXT_PREVIEW_BYTES,
} from "./result.ts";
import {
  type AttemptRecord,
  type ClusterState,
  type ExecutionState,
  ledgerRows,
  programList,
  stageStrip,
  type TaskState,
} from "./state.ts";
import type { BlobSource } from "./tiles.ts";

export interface PanelDeps {
  /** The store as the page reaches it right now (the demo's in-memory store, or the CDN). */
  blobs(): BlobSource;
  /** Where the store's blobs are addressed from, `<base>/<hash>`; null for the demo's in-page store. */
  storeBase(): string | null;
  /** Issue a control; false when the machine is not there to take it. */
  send(control: ControlRequest): boolean;
  /** Ask the page to render again once a fetch has landed or a panel's own state moved. */
  rerender(): void;
  now(): number;
  /** The one panel this page shows full-width in its own tab (WP6.3), or null on the dashboard. */
  panelMode?: "ledger" | "files" | "activity" | null;
  /** A file to show at once on the files tab, from the page's query (WP6.8). */
  openFile?: FileEntry | null;
  /** A filesystem root to browse at once, from the page's query. */
  openRoot?: string | null;
}

export interface Panels {
  render(state: ClusterState): void;
  /** Select a task for the detail panel (null clears it). */
  selectTask(taskId: string | null): void;
  /** Browse a filesystem root in the files panel (null follows the execution). */
  browseRoot(root: string | null): void;
  readonly selectedTask: string | null;
  readonly browsingRoot: string | null;
}

const $ = <T extends Element>(root: ParentNode, sel: string): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`panels: missing element ${sel}`);
  return el;
};

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const short = (hash: string, n = 12): string => `${hash.slice(0, n)}…`;
const fmtTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
const ago = (from: number, now: number): string => {
  const s = Math.max(0, Math.round((now - from) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`;
};

type Cached = Uint8Array | null | "pending" | "error";

/** Fetches by hash, once each; a render reads what has landed and a landing asks for a render. */
class BlobCache {
  private readonly got = new Map<string, Cached>();
  private readonly source: () => BlobSource;
  private readonly onChange: () => void;
  /** Bumped whenever a fetch settles, so a panel's signature changes with it. */
  version = 0;
  constructor(source: () => BlobSource, onChange: () => void) {
    this.source = source;
    this.onChange = onChange;
  }
  get(hash: string): Cached {
    const known = this.got.get(hash);
    if (known !== undefined) return known;
    this.got.set(hash, "pending");
    void this.source()
      .get(hash)
      .then((bytes) => {
        // A blob that is not there yet may land later; ask again on the next render.
        if (bytes === null) this.got.delete(hash);
        else this.got.set(hash, bytes);
        this.version += 1;
        this.onChange();
      })
      .catch(() => {
        this.got.set(hash, "error");
        this.version += 1;
        this.onChange();
      });
    return "pending";
  }
}

export function mountPanels(root: ParentNode, deps: PanelDeps): Panels {
  const els = {
    programs: $<HTMLDivElement>(root, "#programs"),
    queue: $<HTMLUListElement>(root, "#queue"),
    strip: $<HTMLDivElement>(root, "#strip"),
    failure: $<HTMLDivElement>(root, "#failure"),
    warnings: $<HTMLUListElement>(root, "#warnings"),
    result: $<HTMLDivElement>(root, "#result"),
    files: $<HTMLDivElement>(root, "#files"),
    filesRoot: $<HTMLSpanElement>(root, "#filesRoot"),
    filePreview: $<HTMLDivElement>(root, "#filePreview"),
    taskDetail: $<HTMLDivElement>(root, "#taskDetail"),
    ledger: $<HTMLTableSectionElement>(root, "#ledger tbody"),
    ledgerNote: $<HTMLParagraphElement>(root, "#ledgerNote"),
    ledgerSummary: $<HTMLParagraphElement>(root, "#ledgerSummary"),
    filesSummary: $<HTMLParagraphElement>(root, "#filesSummary"),
    followUp: $<HTMLDivElement>(root, "#followUp"),
    killExecution: $<HTMLButtonElement>(root, "#killExecution"),
  };
  const cache = new BlobCache(deps.blobs, deps.rerender);
  let selectedTask: string | null = null;
  let browsingRoot: string | null = deps.openRoot ?? null;
  let selectedFile: FileEntry | null = deps.openFile ?? null;
  /** A viewer tab opened on a file keeps it across executions until the reader browses elsewhere. */
  let pinned = deps.openFile != null || deps.openRoot != null;
  let dismissedFailure: string | null = null;
  /** Programs whose launch form is open, with the text typed so far. */
  const launchForms = new Map<string, { params: string; error: string | null }>();
  let last: ClusterState | null = null;
  /** What each panel last drew; a panel redraws only when its signature moves. */
  const drawn = new Map<string, string>();
  const changed = (panel: string, signature: string): boolean => {
    if (drawn.get(panel) === signature) return false;
    drawn.set(panel, signature);
    return true;
  };

  els.killExecution.onclick = () => {
    const exec = last?.execution;
    if (exec) deps.send({ t: "killExecution", executionId: exec.executionId });
  };

  // ---- programs --------------------------------------------------------------------------------

  function renderPrograms(state: ClusterState): void {
    const programs = programList(state);
    const running =
      state.execution && state.execution.phase !== "done" ? state.execution.program : null;
    const sig = JSON.stringify([
      programs.map((p) => [p.bundle, p.name, p.view, p.description]),
      running,
      [...launchForms.entries()],
    ]);
    if (!changed("programs", sig)) return;
    els.programs.replaceChildren();
    if (programs.length === 0) {
      els.programs.append(
        el(
          "p",
          "muted",
          "No programs yet. The machine seeds its demos at boot; the editor uploads more.",
        ),
      );
      return;
    }
    for (const p of programs) {
      const row = el("div", "program");
      row.dataset.bundle = p.bundle;
      const head = el("div", "program-head");
      head.append(el("b", undefined, p.name));
      head.append(el("span", "pill", p.view ?? "view unknown"));
      if (running === p.bundle) head.append(el("span", "pill live", "running"));
      const launch = el("button", undefined, launchForms.has(p.bundle) ? "cancel" : "launch…");
      launch.type = "button";
      launch.dataset.launch = p.name;
      launch.onclick = () => {
        if (launchForms.has(p.bundle)) launchForms.delete(p.bundle);
        else launchForms.set(p.bundle, { params: JSON.stringify(p.defaultParams), error: null });
        deps.rerender();
      };
      head.append(launch);
      row.append(head);
      if (p.description) row.append(el("div", "muted small", p.description));
      row.append(el("div", "mono muted small", `bundle ${short(p.bundle)}`));
      const form = launchForms.get(p.bundle);
      if (form) {
        const box = el("div", "launch-form");
        const label = el("label", undefined, "params (JSON object)");
        const input = el("textarea");
        input.rows = 2;
        input.value = form.params;
        input.spellcheck = false;
        // Typing edits the form's text without a redraw, so the caret stays where it is.
        input.oninput = () => {
          form.params = input.value;
          drawn.set("programs", `${drawn.get("programs") ?? ""}~`);
        };
        label.append(input);
        box.append(label);
        const go = el("button", undefined, `launch ${p.name}`);
        go.type = "button";
        go.dataset.launchGo = p.name;
        go.onclick = () => {
          let params: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(form.params || "{}");
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
              throw new Error("params must be a JSON object");
            params = parsed as Record<string, unknown>;
          } catch (err) {
            form.error = err instanceof Error ? err.message : String(err);
            deps.rerender();
            return;
          }
          const sent = deps.send({ t: "launch", bundle: p.bundle, params, inherit: null });
          form.error = sent ? null : "not connected";
          if (sent) launchForms.delete(p.bundle);
          deps.rerender();
        };
        box.append(go);
        if (form.error) box.append(el("div", "bad small", form.error));
        row.append(box);
      }
      els.programs.append(row);
    }
  }

  // ---- queue -----------------------------------------------------------------------------------

  function renderQueue(state: ClusterState): void {
    const now = deps.now();
    const rows = state.queue.map((q, i) => ({
      text: `${i + 1}. ${q.programName} ${q.executionId} · ${q.human ? "person" : "loop"} · waiting ${ago(q.queuedAt, now)}`,
      executionId: q.executionId,
    }));
    if (!changed("queue", JSON.stringify(rows))) return;
    els.queue.replaceChildren(
      ...rows.map((r) => {
        const li = el("li", "queue-row");
        li.append(el("span", "mono", r.text));
        const drop = el("button", "small", "drop");
        drop.type = "button";
        drop.title = "Remove this execution from the queue";
        drop.dataset.drop = r.executionId;
        drop.onclick = () => deps.send({ t: "killExecution", executionId: r.executionId });
        li.append(drop);
        return li;
      }),
    );
    if (rows.length === 0) els.queue.append(el("li", "muted", "empty"));
  }

  // ---- stage strip -----------------------------------------------------------------------------

  function renderStrip(state: ClusterState): void {
    const entries = stageStrip(state);
    if (!changed("strip", JSON.stringify(entries))) return;
    els.strip.hidden = entries.length === 0;
    els.strip.replaceChildren(
      ...entries.map((e) => {
        if (e.kind === "plan") {
          const chip = el("span", "stage stage-plan");
          chip.dataset.stage = String(e.stage);
          chip.append(
            el("b", undefined, `plan ${e.stage}`),
            el("span", "muted", e.holders.length ? `on ${e.holders.join(", ")}` : "waiting"),
          );
          return chip;
        }
        const s = e.stage;
        const chip = el("span", `stage stage-${s.status}${e.current ? " stage-current" : ""}`);
        chip.dataset.stage = String(s.stage);
        const title = s.known ? `${s.stage} ${s.name}` : `${s.stage}`;
        chip.append(el("b", undefined, title));
        const tally = s.known
          ? `${s.done}/${s.taskCount}${s.failed ? ` · ${s.failed} failed` : ""}`
          : "before this page joined";
        chip.append(el("span", "muted", tally));
        if (s.root) {
          const root = s.root;
          const link = el("a", "mono", short(root, 8));
          link.href = "#filesPanel";
          link.title = `browse the filesystem after stage ${s.stage}: ${root}`;
          link.onclick = (ev) => {
            ev.preventDefault();
            browseRoot(root);
          };
          chip.append(link);
        }
        return chip;
      }),
    );
  }

  // ---- failures and warnings -------------------------------------------------------------------

  function renderFailure(state: ClusterState): void {
    const f = state.lastFailure;
    const key = f ? `${f.executionId}:${f.reason}` : null;
    const warnings = state.execution?.warnings ?? [];
    if (!changed("failure", JSON.stringify([f, dismissedFailure, warnings]))) return;
    if (!f || key === dismissedFailure) {
      els.failure.hidden = true;
      els.failure.replaceChildren();
    } else {
      els.failure.hidden = false;
      const text = el("span");
      text.append(el("b", undefined, `${f.programName} ${f.executionId} failed`), ` — ${f.reason}`);
      const when = el("span", "muted", ` at ${fmtTime(f.at)}`);
      const dismiss = el("button", "small", "dismiss");
      dismiss.type = "button";
      dismiss.onclick = () => {
        dismissedFailure = key;
        deps.rerender();
      };
      els.failure.replaceChildren(text, when, dismiss);
    }
    els.warnings.hidden = warnings.length === 0;
    els.warnings.replaceChildren(...warnings.map((w) => el("li", undefined, `warning: ${w}`)));
  }

  function renderFollowUp(state: ClusterState): void {
    const exec = state.execution;
    const sig = JSON.stringify([exec?.executionId, exec?.phase, exec?.human, exec?.followUp]);
    if (!changed("followUp", sig)) return;
    const offered = exec && exec.phase === "done" && exec.human && exec.followUp;
    els.followUp.hidden = !offered;
    els.followUp.replaceChildren();
    els.killExecution.hidden =
      !exec || exec.phase === "done" || exec.phase === "failed" || exec.phase === "stopped";
    if (!offered || !exec.followUp) return;
    const params = exec.followUp;
    const button = el("button", undefined, `run follow-up ${JSON.stringify(params)}`);
    button.type = "button";
    button.id = "runFollowUp";
    button.title =
      "The program suggested these params for its next run; nothing runs unless you ask";
    button.onclick = () => {
      button.disabled = true;
      deps.send({ t: "runFollowUp", executionId: exec.executionId });
    };
    els.followUp.append(
      button,
      el("span", "muted small", " — a person's follow-up is offered, never queued on its own"),
    );
  }

  // ---- result view (bars, text) ---------------------------------------------------------------

  function renderResult(state: ClusterState): void {
    const exec = state.execution;
    const current = exec?.stages[exec.stage];
    const sig = JSON.stringify([
      exec?.executionId,
      exec?.view,
      exec?.phase,
      exec?.root,
      exec?.failure,
      exec?.stage,
      current,
      cache.version,
    ]);
    if (!changed("result", sig)) return;
    if (!exec || exec.view === "tiles") {
      els.result.hidden = true;
      els.result.replaceChildren();
      return;
    }
    els.result.hidden = false;
    els.result.dataset.view = exec.view;
    if (exec.phase === "failed") {
      els.result.replaceChildren(
        el("p", "bad", `no result: ${exec.failure ?? "the execution failed"}`),
      );
      return;
    }
    if (!exec.root || exec.phase !== "done") {
      els.result.replaceChildren(
        el(
          "p",
          "muted",
          exec.phase === "planning"
            ? `${exec.view} view: planning stage ${exec.stage}; the result appears when the last stage folds.`
            : `${exec.view} view: stage ${exec.stage}${current?.name ? ` ${current.name}` : ""} in progress${current ? `, ${current.done}/${current.taskCount}` : ""}; the result appears when the last stage folds.`,
        ),
      );
      return;
    }
    const manifest = cache.get(exec.root);
    if (manifest === "pending") {
      els.result.replaceChildren(el("p", "muted", "fetching the result…"));
      return;
    }
    if (manifest === "error" || manifest === null) {
      els.result.replaceChildren(el("p", "bad", "the result's manifest could not be fetched"));
      return;
    }
    let final: FileEntry | null;
    try {
      final = finalOutput(parseManifest(manifest));
    } catch {
      els.result.replaceChildren(el("p", "bad", "the root is not a filesystem manifest"));
      return;
    }
    if (!final) {
      els.result.replaceChildren(
        el("p", "muted", "the last stage produced several outputs; see the files panel"),
      );
      return;
    }
    const bytes = cache.get(final.hash);
    if (bytes === "pending") {
      els.result.replaceChildren(el("p", "muted", `fetching ${final.path}…`));
      return;
    }
    if (bytes === "error" || bytes === null) {
      els.result.replaceChildren(el("p", "bad", `${final.path} could not be fetched`));
      return;
    }
    const head = el("div", "result-head muted small", `${final.path} · ${fmtBytes(final.size)}`);
    if (exec.view === "bars") {
      const r = readBars(bytes);
      if (!r.ok) {
        els.result.replaceChildren(head, el("p", "bad", `not a bars payload: ${r.error}`));
        return;
      }
      els.result.replaceChildren(head, barsList(r.bars, exec.view));
      return;
    }
    const text = new TextDecoder().decode(bytes.subarray(0, TEXT_PREVIEW_BYTES));
    els.result.replaceChildren(head, el("pre", "text-view", text));
    if (bytes.length > TEXT_PREVIEW_BYTES)
      els.result.append(
        el("p", "muted small", `showing the first ${fmtBytes(TEXT_PREVIEW_BYTES)}`),
      );
  }

  function barsList(bars: Parameters<typeof barRows>[0], view: string): HTMLElement {
    const list = el("ol", "bars");
    list.dataset.view = view;
    for (const b of barRows(bars)) {
      const li = el("li", "bar-row");
      li.dataset.label = b.label;
      const label = el("span", "bar-label", b.label);
      const track = el("span", "bar-track");
      const fill = el("span", "bar-fill");
      fill.style.width = `${Math.max(0.5, b.fraction * 100).toFixed(1)}%`;
      track.append(fill);
      const value = el("span", "bar-value mono", fmtValue(b.value));
      li.append(label, track, value);
      list.append(li);
    }
    if (bars.length > 40) list.append(el("li", "muted small", `… and ${bars.length - 40} more`));
    return list;
  }

  // ---- files -----------------------------------------------------------------------------------

  function tileHint(
    exec: ExecutionState | null,
    state: ClusterState,
  ): { w: number; h: number } | null {
    if (exec?.view !== "tiles") return null;
    for (const t of state.tasks.values()) if (t.place) return { w: t.place.w, h: t.place.h };
    return { w: 64, h: 64 };
  }

  function renderFiles(state: ClusterState): void {
    const exec = state.execution;
    const root = browsingRoot ?? exec?.root ?? null;
    const sig = JSON.stringify([
      root,
      browsingRoot,
      exec?.executionId,
      selectedFile,
      cache.version,
    ]);
    if (!changed("files", sig)) return;
    els.filesRoot.textContent = root ? short(root, 16) : "—";
    els.filesRoot.title = root ?? "";
    els.filesSummary.textContent = root
      ? `root ${short(root, 12)} · fetching the manifest…`
      : exec
        ? "no filesystem yet: the first stage has not folded"
        : "no execution";
    els.files.replaceChildren();
    if (!root) {
      els.files.append(
        el(
          "p",
          "muted",
          exec ? "no filesystem yet: the first stage has not folded" : "no execution",
        ),
      );
      renderPreview(state);
      return;
    }
    const bytes = cache.get(root);
    if (bytes === "pending") {
      els.files.append(el("p", "muted", "fetching the manifest…"));
      return;
    }
    if (bytes === "error" || bytes === null) {
      els.files.append(el("p", "bad", "the manifest could not be fetched"));
      return;
    }
    let files: FileEntry[];
    try {
      files = listFiles(parseManifest(bytes));
    } catch {
      els.files.append(el("p", "bad", "not a filesystem manifest"));
      return;
    }
    const groups = groupFiles(files);
    const total = files.reduce((n, f) => n + f.size, 0);
    els.filesSummary.textContent = `root ${short(root, 12)} · ${files.length} files · ${fmtBytes(total)} · every byte fetched from the store by hash`;
    els.files.append(
      el(
        "div",
        "muted small",
        `${files.length} files · ${fmtBytes(total)}${browsingRoot ? " · browsing a chosen root" : ""}`,
      ),
    );
    if (deps.panelMode === "files" && exec) {
      // The files tab cannot see the stage strip: the stages' roots are offered here instead.
      const roots = el("div", "muted small");
      roots.append("roots: ");
      for (const s of exec.stages) {
        if (!s.root) continue;
        const b = el("button", "small", `stage ${s.stage}`);
        b.type = "button";
        b.dataset.rootStage = String(s.stage);
        b.title = s.root;
        b.onclick = () => browseRoot(s.root);
        roots.append(b, " ");
      }
      els.files.append(roots);
    }
    if (browsingRoot) {
      const follow = el("button", "small", "follow the execution");
      follow.type = "button";
      follow.onclick = () => browseRoot(null);
      els.files.append(follow);
    }
    for (const g of groups) {
      const section = el("div", "file-group");
      section.append(
        el("div", "file-group-head mono", `${g.label} · ${g.files.length} · ${fmtBytes(g.bytes)}`),
      );
      const list = el("ul", "plain files");
      for (const f of g.files) {
        const isSelected = selectedFile?.hash === f.hash && selectedFile.path === f.path;
        const li = el("li", `file${isSelected ? " selected" : ""}`);
        li.dataset.path = f.path;
        li.title = f.hash;
        // The name opens the file in its own tab, rendered (WP6.8); the row still selects it here.
        const name = el("a", "mono open-file", f.path);
        name.href = fileViewerUrl(root, f);
        name.target = "_blank";
        name.rel = "noreferrer";
        name.title = `open ${f.path} in a new tab`;
        name.onclick = (ev) => ev.stopPropagation();
        li.append(name, el("span", "muted", ` ${fmtBytes(f.size)} · ${short(f.hash, 8)}`));
        li.onclick = () => {
          pinned = false;
          selectedFile = isSelected ? null : f;
          deps.rerender();
        };
        list.append(li);
      }
      section.append(list);
      els.files.append(section);
    }
    renderPreview(state);
  }

  /**
   * The files tab with one file selected and its filesystem root pinned (WP6.8). It keeps the
   * page's own query — a demo replays the same demo, a live page opens an observer — and only
   * swaps the panel and the file.
   */
  function fileViewerUrl(root: string, f: FileEntry): string {
    const q = new URLSearchParams(location.search);
    for (const k of ["root", "file", "path", "size"]) q.delete(k);
    if (!q.has("demo")) q.set("observe", "");
    q.set("panel", "files");
    q.set("root", root);
    q.set("file", f.hash);
    q.set("path", f.path);
    if (f.size) q.set("size", String(f.size));
    return `/?${q.toString()}`;
  }

  function renderPreview(state: ClusterState): void {
    const f = selectedFile;
    els.filePreview.hidden = !f;
    els.filePreview.replaceChildren();
    if (!f) return;
    const head = el("div", "muted small mono", `${f.path} · ${fmtBytes(f.size)} · ${f.hash}`);
    const store = deps.storeBase();
    if (store) {
      const raw = el("a", "mono", " raw bytes ↗");
      raw.href = `${store.replace(/\/$/, "")}/${f.hash}`;
      raw.target = "_blank";
      raw.rel = "noreferrer";
      raw.title = "the bytes as the store holds them, by hash";
      head.append(raw);
    }
    els.filePreview.append(head);
    const bytes = cache.get(f.hash);
    if (bytes === "pending") return void els.filePreview.append(el("p", "muted", "fetching…"));
    if (bytes === "error" || bytes === null)
      return void els.filePreview.append(el("p", "bad", "could not be fetched"));
    els.filePreview.append(previewNode(previewOf(bytes, tileHint(state.execution, state)), bytes));
  }

  function previewNode(p: Preview, bytes: Uint8Array): HTMLElement {
    switch (p.kind) {
      case "bars":
        return barsList(p.bars, "preview");
      case "text": {
        const pre = el("pre", "text-view", p.text);
        if (p.truncated) pre.append(`\n… (${fmtBytes(bytes.length)} in all)`);
        return pre;
      }
      case "manifest": {
        const list = el("ul", "plain files");
        for (const f of p.files)
          list.append(el("li", "mono", `${f.path} · ${fmtBytes(f.size)} · ${short(f.hash, 8)}`));
        return list;
      }
      case "image": {
        const canvas = el("canvas", "tile-preview");
        canvas.width = p.w;
        canvas.height = p.h;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const pixels = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          ctx.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, p.w, p.h), 0, 0);
        }
        canvas.title = `${p.w}×${p.h} RGBA`;
        return canvas;
      }
      default:
        return el("pre", "text-view mono", `${p.head}${bytes.length > 64 ? " …" : ""}`);
    }
  }

  // ---- task detail -----------------------------------------------------------------------------

  function renderTask(state: ClusterState): void {
    const task = selectedTask ? state.tasks.get(selectedTask) : undefined;
    if (!task && selectedTask && state.execution) selectedTask = null; // the stage moved on
    if (!changed("task", JSON.stringify([selectedTask, task, cache.version]))) return;
    els.taskDetail.hidden = !task;
    els.taskDetail.replaceChildren();
    if (!task) return;
    const head = el("div", "task-head");
    head.append(
      el("b", "mono", task.taskId),
      el("span", "pill", task.status),
      el(
        "span",
        "muted",
        `${task.kind} · stage ${task.stage}${task.index >= 0 ? ` · index ${task.index}` : ""}`,
      ),
    );
    const close = el("button", "small", "close");
    close.type = "button";
    close.onclick = () => selectTask(null);
    head.append(close);
    els.taskDetail.append(head);
    const facts = el("dl", "facts");
    const fact = (k: string, v: string, cls = "") => {
      facts.append(el("dt", undefined, k));
      facts.append(el("dd", cls, v));
    };
    if (task.place)
      fact("place", `${task.place.x},${task.place.y} ${task.place.w}×${task.place.h}`);
    fact("attempts", String(task.attempts));
    fact("holders", task.holders.length ? task.holders.join(", ") : "none");
    if (task.output) fact("output", task.output, "mono");
    if (task.computeMs !== null) fact("compute", `${task.computeMs} ms`);
    if (task.contested) fact("contested", "results disagreed; recomputed");
    if (task.verified) fact("verified", "a twin agreed");
    if (task.failure) fact("failure", task.failure, "bad");
    els.taskDetail.append(facts);

    const table = el("table", "attempts");
    const thead = el("thead");
    const hr = el("tr");
    for (const h of ["#", "node", "kind", "outcome", "at", "ms"]) hr.append(el("th", undefined, h));
    thead.append(hr);
    table.append(thead);
    const tbody = el("tbody");
    const rows: AttemptRecord[] = task.history;
    for (const a of rows) {
      const tr = el("tr", `outcome-${a.outcome}`);
      tr.append(
        el("td", "num", String(a.attempt)),
        el("td", "mono", a.nodeId),
        el("td", undefined, a.speculative ? "twin" : "primary"),
        el("td", undefined, a.outcome + (a.fromSnapshot ? " (from snapshot)" : "")),
        el("td", "mono", fmtTime(a.at)),
        el("td", "num", a.computeMs === null ? "—" : String(a.computeMs)),
      );
      tbody.append(tr);
    }
    if (rows.length === 0) {
      const tr = el("tr");
      tr.append(el("td", "muted", "no attempts seen yet"));
      tbody.append(tr);
    }
    table.append(tbody);
    els.taskDetail.append(table);

    const logBox = el("div", "task-log");
    if (task.log === null) {
      logBox.append(
        el(
          "p",
          "muted small",
          task.status === "done"
            ? "log: not carried on the wire yet (the control plane keeps it; forwarding is a one-line core change)"
            : "log: appears when the task is done",
        ),
      );
    } else if ("text" in task.log) {
      logBox.append(el("div", "muted small", "log"), el("pre", "text-view", task.log.text));
    } else {
      const bytes = cache.get(task.log.hash);
      logBox.append(el("div", "muted small", `log · ${short(task.log.hash, 8)}`));
      if (bytes === "pending") logBox.append(el("p", "muted", "fetching…"));
      else if (bytes === "error" || bytes === null)
        logBox.append(el("p", "bad", "could not be fetched"));
      else
        logBox.append(
          el("pre", "text-view", new TextDecoder().decode(bytes.subarray(0, TEXT_PREVIEW_BYTES))),
        );
    }
    els.taskDetail.append(logBox);
  }

  // ---- ledger ----------------------------------------------------------------------------------

  /** Sizes the folded manifest knows, by hash, once the execution's root has been fetched. */
  function manifestSizes(exec: ExecutionState | null): Map<string, number> {
    const out = new Map<string, number>();
    if (!exec?.root) return out;
    const bytes = cache.get(exec.root);
    if (bytes === "pending" || bytes === "error" || bytes === null) return out;
    try {
      for (const f of listFiles(parseManifest(bytes))) out.set(f.hash, f.size);
    } catch {
      /* not a manifest: nothing to size */
    }
    return out;
  }

  /**
   * The ledger panel makes the point the architecture rests on: the control plane holds hashes,
   * never bytes. Each settled task shows its output hash, the size when it is known, and where the
   * bytes actually live.
   */
  function renderLedger(state: ClusterState): void {
    const exec = state.execution;
    // The dashboard keeps the newest eight; the ledger's own tab shows every settled task.
    const rows = ledgerRows(state, deps.panelMode === "ledger" ? Number.POSITIVE_INFINITY : 8);
    const store = deps.storeBase();
    const sig = JSON.stringify([exec?.executionId, exec?.stage, rows, store, cache.version]);
    if (!changed("ledger", sig)) return;
    const sizes = manifestSizes(exec);
    let settled = 0;
    let bytes = 0;
    for (const t of state.tasks.values()) {
      if (t.status !== "done") continue;
      settled++;
      bytes += t.place ? t.place.w * t.place.h * 4 : (sizes.get(t.output ?? "") ?? 0);
    }
    els.ledgerSummary.textContent = exec
      ? `${settled} settled ${settled === 1 ? "task" : "tasks"} · ${fmtBytes(bytes)} in the store · hashes, not bytes`
      : "hashes, not bytes — nothing settled yet";
    els.ledgerNote.textContent = exec
      ? `The control plane holds hashes, not bytes: for each of the ${settled} settled ${settled === 1 ? "task" : "tasks"} of stage ${exec.stage} it keeps a 64-hex output hash; the bytes live in ${store ? "the store behind the CDN" : "this page's demo store"} and are fetched by hash. The newest ${Math.min(rows.length, 8) || ""} settled:`
      : "The control plane holds hashes, not bytes. No execution is running, so there is nothing settled to list.";
    els.ledger.replaceChildren(
      ...rows.map((r) => {
        const tr = el("tr");
        tr.dataset.task = r.taskId;
        tr.dataset.hash = r.output;
        const size = r.size ?? sizes.get(r.output) ?? null;
        if (size !== null) tr.dataset.size = String(size);
        // The whole hash and the whole address (WP6.8): this is the point of the panel.
        const hash = el("td", "mono hash", r.output);
        hash.title = r.output;
        const where = el("td");
        if (store) {
          const href = `${store.replace(/\/$/, "")}/${r.output}`;
          const a = el("a", "mono", href);
          a.href = href;
          a.target = "_blank";
          a.rel = "noreferrer";
          a.title = "the bytes, by hash, from the store";
          where.append(a);
        } else {
          const here = el("span", "muted", "demo store");
          here.title = "this page's in-memory store; nothing is on the network";
          where.append(here);
        }
        tr.append(
          el("td", "mono", r.taskId + (r.verified ? " ✓" : "")),
          el("td", "mono", r.nodeId ?? "—"),
          hash,
          el("td", "num", size === null ? "—" : fmtBytes(size)),
          where,
        );
        return tr;
      }),
    );
    if (rows.length === 0) {
      const tr = el("tr");
      const td = el("td", "muted", exec ? "nothing settled yet" : "—");
      td.colSpan = 5;
      tr.append(td);
      els.ledger.append(tr);
    }
  }

  // ---- glue -----------------------------------------------------------------------------------

  function selectTask(taskId: string | null): void {
    selectedTask = taskId;
    deps.rerender();
  }

  function browseRoot(root: string | null): void {
    pinned = false;
    browsingRoot = root;
    selectedFile = null;
    deps.rerender();
  }

  function render(state: ClusterState): void {
    const changedExecution = last?.execution?.executionId !== state.execution?.executionId;
    if (changedExecution) {
      if (!pinned) {
        browsingRoot = null;
        selectedFile = null;
      }
      selectedTask = null;
    }
    last = state;
    renderPrograms(state);
    renderQueue(state);
    renderStrip(state);
    renderFailure(state);
    renderFollowUp(state);
    renderResult(state);
    renderFiles(state);
    renderTask(state);
    renderLedger(state);
  }

  return {
    render,
    selectTask,
    browseRoot,
    get selectedTask() {
      return selectedTask;
    },
    get browsingRoot() {
      return browsingRoot;
    },
  };
}

/** Grid geometry shared with the click handler: cell size and columns for `n` cells in `width`. */
export function gridLayout(
  n: number,
  width: number,
): { cell: number; cols: number; lines: number } {
  const cell = Math.max(3, Math.min(14, Math.floor(Math.sqrt((width * 96) / Math.max(1, n)))));
  const cols = Math.max(1, Math.floor(width / cell));
  return { cell, cols, lines: Math.ceil(n / cols) };
}

/** Which cell a click at (x, y) in canvas pixels lands on, or -1 outside the cells. */
export function gridIndexAt(n: number, width: number, x: number, y: number): number {
  const { cell, cols } = gridLayout(n, width);
  const col = Math.floor(x / cell);
  const line = Math.floor(y / cell);
  if (col < 0 || col >= cols || line < 0) return -1;
  const index = line * cols + col;
  return index < n ? index : -1;
}

export type { TaskState };
