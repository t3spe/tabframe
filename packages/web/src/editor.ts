// The in-page editor (design §5.6): the Mandelbrot source prefilled, the compiler in a lazily
// loaded worker, diagnostics with line numbers, a manifest and params form, compile → bundle →
// launch through the observer socket, and the drop-a-`.wasm` door. Loaded by host.ts on demand,
// so the dashboard never pays for it.
import { type PresignRequester, StoreClient } from "@tabframe/store/client";
import { sha256Hex } from "@tabframe/store/hash";
import type { WorkerReply, WorkerRequest } from "./compiler-worker.ts";
import {
  ASC_FLAGS,
  assembleSources,
  buildBundle,
  buildManifest,
  type CompileResult,
  type Diagnostic,
  fmtBytes,
  formatDiagnostic,
  inspectModule,
  looksLikeWasm,
  MANDELBROT_SOURCE,
  MAX_MODULE_BYTES,
  type ModuleInfo,
  parseParams,
  shippedManifest,
} from "./editor-core.ts";
import type { ClusterState } from "./state.ts";

/** What the page gives the editor: the socket's upload and launch paths, and the cluster feed. */
export interface EditorHost {
  connected(): boolean;
  storeBase(): string | null;
  presign: PresignRequester["presign"];
  launch(bundle: string, params: Record<string, unknown>): boolean;
  subscribe(listener: (state: ClusterState) => void): () => void;
  /** Where the compiler worker script lives; defaults to `compiler-worker.js` next to this module. */
  workerUrl?: string;
}

export interface EditorHandle {
  /** The module that would be launched right now, if any. */
  readonly module: Uint8Array | null;
  readonly lastCompile: CompileResult | null;
  readonly compilerLoadMs: number | null;
  compile(): Promise<CompileResult>;
  launch(): Promise<boolean>;
  close(): void;
}

const $ = <T extends Element>(root: ParentNode, sel: string): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`editor: missing element ${sel}`);
  return el;
};

/** Mount the editor into its section. Idempotent per section: a second call returns the first handle. */
export function mountEditor(root: HTMLElement, host: EditorHost): EditorHandle {
  const existing = (root as HTMLElement & { __editor?: EditorHandle }).__editor;
  if (existing) return existing;

  const els = {
    status: $<HTMLSpanElement>(root, "#editorStatus"),
    source: $<HTMLTextAreaElement>(root, "#source"),
    compile: $<HTMLButtonElement>(root, "#compile"),
    launch: $<HTMLButtonElement>(root, "#launch"),
    reset: $<HTMLButtonElement>(root, "#resetSource"),
    note: $<HTMLSpanElement>(root, "#compileNote"),
    diagnostics: $<HTMLUListElement>(root, "#diagnostics"),
    name: $<HTMLInputElement>(root, "#programName"),
    view: $<HTMLSelectElement>(root, "#programView"),
    description: $<HTMLInputElement>(root, "#programDescription"),
    params: $<HTMLTextAreaElement>(root, "#programParams"),
    drop: $<HTMLDivElement>(root, "#editorDrop"),
    file: $<HTMLInputElement>(root, "#wasmFile"),
    moduleInfo: $<HTMLDivElement>(root, "#moduleInfo"),
    launchInfo: $<HTMLDivElement>(root, "#launchInfo"),
    close: $<HTMLButtonElement>(root, "#closeEditor"),
  };

  // ---- prefill ---------------------------------------------------------------------------------
  const shipped = shippedManifest();
  if (!els.source.value) els.source.value = MANDELBROT_SOURCE;
  els.name.value = shipped.name;
  els.view.value = shipped.view;
  els.description.value = shipped.description ?? "";
  els.params.value = JSON.stringify(shipped.defaultParams);

  let module: Uint8Array | null = null;
  let moduleFrom: "compiled" | "dropped" | null = null;
  let lastCompile: CompileResult | null = null;
  let compilerLoadMs: number | null = null;
  let busy = false;

  const status = (text: string, tone: "wait" | "live" | "off" | "" = "") => {
    els.status.textContent = text;
    els.status.className = `pill ${tone}`;
  };
  const info = (el: HTMLElement, text: string, bad = false) => {
    el.textContent = text;
    el.className = bad ? "bad" : "muted";
  };

  // ---- the compiler worker, loaded on first use --------------------------------------------------
  let worker: Worker | null = null;
  let ready: Promise<string> | null = null;
  let nextId = 1;
  const pending = new Map<number, (r: CompileResult) => void>();

  function ensureWorker(): Promise<string> {
    if (ready) return ready;
    const started = performance.now();
    status("compiler: loading…", "wait");
    ready = new Promise<string>((resolve, reject) => {
      const url = host.workerUrl ?? new URL("./compiler-worker.js", import.meta.url).href;
      const w = new Worker(url, { type: "module", name: "tabframe-compiler" });
      worker = w;
      w.onmessage = (ev: MessageEvent<WorkerReply>) => {
        const msg = ev.data;
        if (msg.type === "ready") {
          compilerLoadMs = Math.round(performance.now() - started);
          status(
            `compiler ${msg.version} ready in ${(compilerLoadMs / 1000).toFixed(1)} s`,
            "live",
          );
          resolve(msg.version);
          return;
        }
        if (msg.type === "compiled") {
          const settle = pending.get(msg.id);
          pending.delete(msg.id);
          const { type: _t, id: _id, ...result } = msg;
          settle?.(result);
        }
      };
      w.onerror = (e) => {
        status(`compiler failed to load: ${e.message}`, "off");
        ready = null;
        worker = null;
        reject(new Error(e.message));
      };
    });
    return ready;
  }

  function compileInWorker(source: string): Promise<CompileResult> {
    return new Promise((resolve, reject) => {
      const w = worker;
      if (!w) return reject(new Error("no compiler worker"));
      const id = nextId++;
      pending.set(id, resolve);
      const req: WorkerRequest = {
        type: "compile",
        id,
        fs: assembleSources(source),
        flags: [...ASC_FLAGS],
      };
      w.postMessage(req);
    });
  }

  // ---- compile ------------------------------------------------------------------------------------
  function renderDiagnostics(list: Diagnostic[]): void {
    els.diagnostics.replaceChildren(
      ...list.map((d) => {
        const li = document.createElement("li");
        li.className = `diag diag-${d.level}`;
        li.textContent = formatDiagnostic(d);
        if (d.line !== null && (d.file === null || d.file.startsWith("program/"))) {
          li.title = "click to jump to the line";
          li.style.cursor = "pointer";
          li.onclick = () => jumpTo(d.line as number, d.column ?? 1);
        }
        return li;
      }),
    );
  }

  function jumpTo(line: number, column: number): void {
    const lines = els.source.value.split("\n");
    let pos = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) pos += (lines[i] as string).length + 1;
    pos += Math.max(0, column - 1);
    els.source.focus();
    els.source.setSelectionRange(pos, pos);
  }

  async function showModule(bytes: Uint8Array, from: "compiled" | "dropped"): Promise<ModuleInfo> {
    const m = inspectModule(bytes);
    const hash = await sha256Hex(bytes);
    if (!m.ok) {
      module = null;
      moduleFrom = null;
      els.launch.disabled = true;
      els.moduleInfo.innerHTML = "";
      const p = document.createElement("span");
      p.className = "bad";
      p.textContent = `${from} module refused: ${m.reason}`;
      els.moduleInfo.append(p);
      return m;
    }
    module = bytes;
    moduleFrom = from;
    els.launch.disabled = false;
    els.moduleInfo.className = "";
    els.moduleInfo.replaceChildren(
      line(`${from} module · ${fmtBytes(m.size)} (${m.size} bytes)`),
      line("sha256 ", code(hash, "moduleHash")),
      line(`imports ${m.imports.join(", ") || "none"}`),
      line(`exports ${m.exports.join(", ")}`),
      line(`memory max ${m.memoryMax === null ? "undeclared" : `${m.memoryMax} pages`}`),
    );
    return m;
  }

  async function compile(): Promise<CompileResult> {
    if (busy) return lastCompile ?? { ok: false, wasm: null, diagnostics: [], stderr: "", ms: 0 };
    busy = true;
    els.compile.disabled = true;
    try {
      await ensureWorker();
      status("compiling…", "wait");
      const result = await compileInWorker(els.source.value);
      lastCompile = result;
      renderDiagnostics(result.diagnostics);
      const errors = result.diagnostics.filter((d) => d.level === "error").length;
      if (result.ok && result.wasm) {
        status(`compiled in ${result.ms} ms`, "live");
        info(els.note, `${result.wasm.length} bytes${errors ? "" : ", no diagnostics"}`);
        await showModule(result.wasm, "compiled");
      } else {
        status(`${errors} error${errors === 1 ? "" : "s"}`, "off");
        info(els.note, "no module produced", true);
        if (moduleFrom === "compiled") {
          module = null;
          moduleFrom = null;
          els.launch.disabled = true;
          info(els.moduleInfo, "the previous module was discarded");
        }
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      status(`compile failed: ${message}`, "off");
      return { ok: false, wasm: null, diagnostics: [], stderr: message, ms: 0 };
    } finally {
      busy = false;
      els.compile.disabled = false;
    }
  }

  // ---- launch -------------------------------------------------------------------------------------
  let awaitingAnswer = false;
  let launchedAt = 0;
  let launchedName = "";
  let unsubscribe: (() => void) | null = null;

  async function launch(): Promise<boolean> {
    if (!module) {
      info(els.launchInfo, "compile the program or drop a .wasm first", true);
      return false;
    }
    const params = parseParams(els.params.value);
    if (!params.ok) {
      info(els.launchInfo, params.error, true);
      return false;
    }
    const manifest = buildManifest({
      name: els.name.value,
      view: els.view.value,
      description: els.description.value,
      defaultParams: params.value,
    });
    if (!manifest.ok) {
      info(els.launchInfo, manifest.error, true);
      return false;
    }
    const base = host.storeBase();
    if (!host.connected() || !base) {
      info(els.launchInfo, "not connected to the machine; nothing was sent", true);
      return false;
    }
    els.launch.disabled = true;
    launchedAt = Date.now();
    try {
      const bundle = await buildBundle(module, manifest.value);
      info(els.launchInfo, `uploading ${bundle.blobs.length} blobs…`);
      const store = new StoreClient(base, { presign: (items) => host.presign(items) });
      await store.putMany(bundle.blobs);
      awaitingAnswer = true;
      launchedName = manifest.value.name;
      const sent = host.launch(bundle.bundle, params.value);
      if (!sent) {
        info(els.launchInfo, "the socket closed before the launch was sent", true);
        return false;
      }
      els.launchInfo.replaceChildren(
        line(
          `uploaded ${bundle.blobs.length} blobs · launch sent for bundle `,
          code(bundle.bundle, "bundleHash"),
        ),
        line("waiting for the control plane…"),
      );
      if (!unsubscribe) unsubscribe = host.subscribe(onCluster);
      return true;
    } catch (err) {
      info(
        els.launchInfo,
        `upload failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
      return false;
    } finally {
      els.launch.disabled = module === null;
    }
  }

  /** The control plane answers a launch with an error message or with a queued execution. */
  function onCluster(state: ClusterState): void {
    if (!awaitingAnswer) return;
    const err = state.activity.filter((a) => a.kind === "error" && a.at >= launchedAt).at(-1);
    if (err) {
      info(els.launchInfo, `the control plane answered: ${err.text}`, true);
      awaitingAnswer = false;
      return;
    }
    const running =
      state.execution?.human && state.execution.programName === launchedName
        ? state.execution
        : null;
    const mine = [...state.queue].reverse().find((q) => q.human && q.programName === launchedName);
    if (running) {
      info(els.launchInfo, `running as ${running.executionId} · ${running.phase}`);
      if (running.phase === "done" || running.phase === "failed") awaitingAnswer = false;
    } else if (mine) {
      info(
        els.launchInfo,
        `queued as ${mine.executionId}; a person's launch goes ahead of the machine's own loop`,
      );
    }
  }

  // ---- the drop-a-.wasm door ---------------------------------------------------------------------
  async function takeFile(file: File): Promise<void> {
    if (file.size > MAX_MODULE_BYTES) {
      info(
        els.moduleInfo,
        `${file.name} is ${fmtBytes(file.size)}; the cap is ${fmtBytes(MAX_MODULE_BYTES)}`,
        true,
      );
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!looksLikeWasm(bytes)) {
      info(els.moduleInfo, `${file.name} is not a WebAssembly module (no \\0asm magic)`, true);
      return;
    }
    const m = await showModule(bytes, "dropped");
    if (m.ok) {
      const stem = file.name
        .replace(/\.wasm$/i, "")
        .replace(/[^A-Za-z0-9._-]/g, "-")
        .slice(0, 64);
      if (stem && els.name.value === shipped.name) els.name.value = stem;
      status(`${file.name} accepted`, "live");
    } else {
      status(`${file.name} refused`, "off");
    }
  }
  els.drop.ondragover = (e) => {
    e.preventDefault();
    els.drop.classList.add("over");
  };
  els.drop.ondragleave = () => els.drop.classList.remove("over");
  els.drop.ondrop = (e) => {
    e.preventDefault();
    els.drop.classList.remove("over");
    const file = e.dataTransfer?.files?.[0];
    if (file) void takeFile(file);
  };
  els.file.onchange = () => {
    const file = els.file.files?.[0];
    if (file) void takeFile(file);
    els.file.value = "";
  };

  // ---- wiring -------------------------------------------------------------------------------------
  els.compile.onclick = () => void compile();
  els.launch.onclick = () => void launch();
  els.reset.onclick = () => {
    els.source.value = MANDELBROT_SOURCE;
    els.params.value = JSON.stringify(shipped.defaultParams);
    els.name.value = shipped.name;
    els.view.value = shipped.view;
    renderDiagnostics([]);
    info(els.note, "source reset to the shipped program");
  };
  els.source.onkeydown = (e) => {
    // Tab inserts two spaces instead of leaving the field.
    if (e.key === "Tab") {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: t, value } = els.source;
      els.source.value = `${value.slice(0, s)}  ${value.slice(t)}`;
      els.source.setSelectionRange(s + 2, s + 2);
    }
  };
  els.close.onclick = () => handle.close();
  status("compiler: idle (loads on first compile)");
  void ensureWorker().catch(() => undefined);

  const handle: EditorHandle = {
    get module() {
      return module;
    },
    get lastCompile() {
      return lastCompile;
    },
    get compilerLoadMs() {
      return compilerLoadMs;
    },
    compile,
    launch,
    close() {
      root.hidden = true;
      unsubscribe?.();
      unsubscribe = null;
      root.dispatchEvent(new CustomEvent("editor-closed"));
    },
  };
  (root as HTMLElement & { __editor?: EditorHandle }).__editor = handle;
  return handle;
}

function line(text: string, ...rest: Node[]): HTMLDivElement {
  const div = document.createElement("div");
  div.append(text, ...rest);
  return div;
}

function code(text: string, id?: string): HTMLElement {
  const c = document.createElement("code");
  c.textContent = text;
  if (id) c.id = id;
  c.style.overflowWrap = "anywhere";
  return c;
}
