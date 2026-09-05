// The editor (design §5.6): the Mandelbrot source prefilled, the compiler in a lazily loaded
// worker, diagnostics with line numbers, a manifest and params form, compile → bundle → launch
// through the observer socket, and the drop-a-`.wasm` door. Mounted by the editor page only, so
// the dashboard never pays for it.
import { type PresignRequester, StoreClient } from "@tabframe/store/client";
import { sha256Hex } from "@tabframe/store/hash";
import type { ClusterState, ProgramInfo } from "./cluster-state.ts";
import { CompilerClient, type StatusTone } from "./compiler-client.ts";
import type { CompileResult, Diagnostic } from "./compiler-types.ts";
import { $, code, line } from "./dom.ts";
import {
  buildBundle,
  buildManifest,
  examples,
  formatDiagnostic,
  type InputRef,
  inspectModule,
  looksLikeWasm,
  MANDELBROT_SOURCE,
  MAX_MODULE_BYTES,
  type ModuleInfo,
  shippedManifest,
} from "./editor-core.ts";
import { fmtBytes } from "./format.ts";
import { parseParams } from "./params.ts";
import { fetchBlob, loadBundle } from "./program-loader.ts";
import { programList } from "./selectors.ts";

/** What the page gives the editor: the socket's upload and launch paths, and the cluster feed. */
export interface EditorHost {
  connected(): boolean;
  storeBase(): string | null;
  presign: PresignRequester["presign"];
  /** Send the launch: out now, held for the next socket, or refused because there is no machine. */
  launch(bundle: string, params: Record<string, unknown>): "sent" | "held" | "refused";
  subscribe(listener: (state: ClusterState) => void): () => void;
  /** Where the compiler worker script lives; defaults to `compiler-worker.js` next to this module. */
  workerUrl?: string;
  /** A demo page: the compile is real, launching needs the live machine. */
  demo?: boolean;
  /** The machine acknowledged the launch (queued or running): the pause has really ended. */
  onLaunched?: () => void;
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

/** The module a launch would upload: compiled here (with its source), dropped as a `.wasm`, or none. */
type LoadedModule =
  | { kind: "none" }
  | { kind: "compiled"; bytes: Uint8Array; source: string }
  | { kind: "dropped"; bytes: Uint8Array };

/** A launch waiting for the machine's answer; `acknowledged` once the machine has it. */
type Launch = { bundle: string; name: string; at: number; acknowledged: boolean } | null;

/** What the source box holds: an embedded example, or a program opened from the machine. */
type Loaded =
  | { kind: "example"; key: string }
  | { kind: "machine"; bundle: string; name: string; inputRefs: InputRef[]; hasSource: boolean };

const noResult = (stderr: string): CompileResult => ({
  ok: false,
  wasm: null,
  diagnostics: [],
  stderr,
  ms: 0,
});

/** Mount the editor into its section. Idempotent per section: a second call returns the first handle. */
export function mountEditor(root: HTMLElement, host: EditorHost): EditorHandle {
  const existing = (root as HTMLElement & { __editor?: EditorHandle }).__editor;
  if (existing) return existing;

  const els = {
    status: $<HTMLSpanElement>("#editorStatus", root),
    source: $<HTMLTextAreaElement>("#source", root),
    compile: $<HTMLButtonElement>("#compile", root),
    launch: $<HTMLButtonElement>("#launch", root),
    reset: $<HTMLButtonElement>("#resetSource", root),
    example: root.querySelector<HTMLSelectElement>("#example"),
    exampleNote: root.querySelector<HTMLSpanElement>("#exampleNote"),
    note: $<HTMLSpanElement>("#compileNote", root),
    diagnostics: $<HTMLUListElement>("#diagnostics", root),
    name: $<HTMLInputElement>("#programName", root),
    view: $<HTMLSelectElement>("#programView", root),
    description: $<HTMLInputElement>("#programDescription", root),
    params: $<HTMLTextAreaElement>("#programParams", root),
    drop: $<HTMLDivElement>("#editorDrop", root),
    file: $<HTMLInputElement>("#wasmFile", root),
    moduleInfo: $<HTMLDivElement>("#moduleInfo", root),
    launchInfo: $<HTMLDivElement>("#launchInfo", root),
    close: $<HTMLButtonElement>("#closeEditor", root),
  };

  const shipped = shippedManifest();
  if (!els.source.value) els.source.value = MANDELBROT_SOURCE;
  els.name.value = shipped.name;
  els.view.value = shipped.view;
  els.description.value = shipped.description ?? "";
  els.params.value = JSON.stringify(shipped.defaultParams);

  let module: LoadedModule = { kind: "none" };
  let loaded: Loaded = { kind: "example", key: "mandelbrot" };
  /** The machine's programs, from the snapshot the pause subscription brings. */
  let machinePrograms: ProgramInfo[] = [];
  let machineListSig = "";
  let lastCompile: CompileResult | null = null;
  let busy = false;
  let launch: Launch = null;
  let unsubscribe: (() => void) | null = null;

  const status = (text: string, tone: StatusTone = "") => {
    els.status.textContent = text;
    els.status.className = `pill ${tone}`;
  };
  const info = (target: HTMLElement, text: string, bad = false) => {
    target.textContent = text;
    target.className = bad ? "bad" : "muted";
  };
  const compiler = new CompilerClient(
    host.workerUrl ?? new URL("./compiler-worker.js", import.meta.url).href,
    { onStatus: status },
  );

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

  function jumpTo(lineNo: number, column: number): void {
    const lines = els.source.value.split("\n");
    let pos = 0;
    for (let i = 0; i < lineNo - 1 && i < lines.length; i++) pos += (lines[i] as string).length + 1;
    pos += Math.max(0, column - 1);
    els.source.focus();
    els.source.setSelectionRange(pos, pos);
  }

  /** Inspect a module and make it the one a launch would upload, or refuse it and keep none. */
  async function showModule(next: Exclude<LoadedModule, { kind: "none" }>): Promise<ModuleInfo> {
    const m = inspectModule(next.bytes);
    const hash = await sha256Hex(next.bytes);
    if (!m.ok) {
      module = { kind: "none" };
      els.launch.disabled = true;
      els.moduleInfo.replaceChildren();
      const p = document.createElement("span");
      p.className = "bad";
      p.textContent = `${next.kind} module refused: ${m.reason}`;
      els.moduleInfo.append(p);
      return m;
    }
    module = next;
    els.launch.disabled = host.demo === true;
    if (host.demo) els.launch.title = "demo: the compile is real; launching needs the live machine";
    els.moduleInfo.className = "";
    els.moduleInfo.replaceChildren(
      line(`${next.kind} module · ${fmtBytes(m.size)} (${m.size} bytes)`),
      line("sha256 ", code(hash, "moduleHash")),
      line(`imports ${m.imports.join(", ") || "none"}`),
      line(`exports ${m.exports.join(", ")}`),
      line(`memory max ${m.memoryMax === null ? "undeclared" : `${m.memoryMax} pages`}`),
    );
    return m;
  }

  async function compile(): Promise<CompileResult> {
    if (busy) return lastCompile ?? noResult("");
    busy = true;
    els.compile.disabled = true;
    try {
      await compiler.warm();
      status("compiling…", "wait");
      const text = els.source.value;
      const result = await compiler.compile(text);
      lastCompile = result;
      renderDiagnostics(result.diagnostics);
      const errors = result.diagnostics.filter((d) => d.level === "error").length;
      if (result.ok && result.wasm) {
        status(`compiled in ${result.ms} ms`, "live");
        info(els.note, `${result.wasm.length} bytes${errors ? "" : ", no diagnostics"}`);
        await showModule({ kind: "compiled", bytes: result.wasm, source: text });
      } else {
        status(`${errors} error${errors === 1 ? "" : "s"}`, "off");
        info(els.note, "no module produced", true);
        if (module.kind === "compiled") {
          module = { kind: "none" };
          els.launch.disabled = true;
          info(els.moduleInfo, "the previous module was discarded");
        }
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      status(`compile failed: ${message}`, "off");
      return noResult(message);
    } finally {
      busy = false;
      els.compile.disabled = false;
    }
  }

  async function launchModule(): Promise<boolean> {
    if (module.kind === "none") {
      info(els.launchInfo, "compile the program or drop a .wasm first", true);
      return false;
    }
    const params = parseParams(els.params.value);
    if (!params.ok) {
      info(els.launchInfo, params.error, true);
      return false;
    }
    // A compiled module travels with its source: the manifest names the source blob's hash, so
    // this program can be reopened in the editor from any browser. A dropped module has none.
    const sourceBytes = module.kind === "compiled" ? new TextEncoder().encode(module.source) : null;
    const sourceHash = sourceBytes ? await sha256Hex(sourceBytes) : undefined;
    const manifest = buildManifest({
      name: els.name.value,
      view: els.view.value,
      description: els.description.value,
      defaultParams: params.value,
      ...(sourceHash ? { source: sourceHash } : {}),
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
    const at = Date.now();
    try {
      const bundle = await buildBundle(module.bytes, manifest.value, [], {
        ...(sourceBytes ? { source: sourceBytes } : {}),
        inputRefs: loaded.kind === "machine" ? loaded.inputRefs : [],
      });
      info(els.launchInfo, `uploading ${bundle.blobs.length} blobs…`);
      const store = new StoreClient(base, { presign: (items) => host.presign(items) });
      await store.putMany(bundle.blobs);
      launch = { bundle: bundle.bundle, name: manifest.value.name, at, acknowledged: false };
      const sent = host.launch(bundle.bundle, params.value);
      if (sent === "refused") {
        info(els.launchInfo, "the socket closed before the launch was sent", true);
        return false;
      }
      if (sent === "held")
        info(
          els.launchInfo,
          "the socket is reconnecting; the launch is held for it and goes out when it is back",
        );
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
      els.launch.disabled = !hasModule();
    }
  }

  /** Read through a call: `module` moves while a launch awaits, which a narrowing would miss. */
  function hasModule(): boolean {
    return module.kind !== "none";
  }

  /** Every cluster state: the machine's program list for the select, then a launch's answer. */
  function onCluster(state: ClusterState): void {
    machinePrograms = programList(state);
    rebuildSelect();
    const mine = launch;
    if (!mine) return;
    const err = state.activity.filter((a) => a.kind === "error" && a.at >= mine.at).at(-1);
    if (err) {
      info(els.launchInfo, `the control plane answered: ${err.text}`, true);
      launch = null;
      return;
    }
    // Matched on the bundle hash, not the name: another visitor's namesake program, or the
    // person's own previous run, must not be reported as this launch.
    const running =
      state.execution?.human && state.execution.program === mine.bundle ? state.execution : null;
    const queued = [...state.queue]
      .reverse()
      .find((q) => q.human && (q.bundle ? q.bundle === mine.bundle : q.programName === mine.name));
    if (running) {
      info(els.launchInfo, `running as ${running.executionId} · ${running.phase}`);
      acknowledge(mine);
      if (running.phase === "done" || running.phase === "failed") launch = null;
    } else if (queued) {
      info(
        els.launchInfo,
        `queued as ${queued.executionId}; a person's launch goes ahead of the machine's own loop`,
      );
      acknowledge(mine);
    }
  }

  function acknowledge(mine: NonNullable<Launch>): void {
    if (mine.acknowledged) return;
    mine.acknowledged = true;
    host.onLaunched?.();
  }

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
    const m = await showModule({ kind: "dropped", bytes });
    if (m.ok) {
      const stem = file.name
        .replace(/\.wasm$/i, "")
        .replace(/[^A-Za-z0-9._-]/g, "-")
        .slice(0, 64);
      if (stem && els.name.value === shipped.name) els.name.value = stem;
      // The text in the box is not this module's source: say so, and stop compiling it.
      els.source.value = `// ${file.name}: a module dropped as a .wasm has no source here.\n// It is loaded below; launch runs it as it is with the params on the right.\n// Pick an example or a program on the machine to edit source again.`;
      els.compile.disabled = true;
      renderDiagnostics([]);
      status(`${file.name} accepted`, "live");
    } else {
      status(`${file.name} refused`, "off");
    }
  }
  const takeFileOrSay = (file: File): void =>
    void takeFile(file).catch((err) =>
      info(
        els.moduleInfo,
        `could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
        true,
      ),
    );
  els.drop.ondragover = (e) => {
    e.preventDefault();
    els.drop.classList.add("over");
  };
  els.drop.ondragleave = () => els.drop.classList.remove("over");
  els.drop.ondrop = (e) => {
    e.preventDefault();
    els.drop.classList.remove("over");
    const file = e.dataTransfer?.files?.[0];
    if (file) takeFileOrSay(file);
  };
  els.file.onchange = () => {
    const file = els.file.files?.[0];
    if (file) takeFileOrSay(file);
    els.file.value = "";
  };

  els.compile.onclick = () => void compile();
  els.launch.onclick = () => void launchModule();
  // The select: every program on the machine first — opened from the store, source and all — then
  // the embedded examples. Reset goes back to whichever is loaded.
  const all = examples();
  const loadExample = (key: string, say: boolean): void => {
    const ex = all.find((e) => e.key === key);
    if (!ex) return;
    loaded = { kind: "example", key };
    els.source.value = ex.source;
    els.params.value = JSON.stringify(ex.manifest.defaultParams);
    els.name.value = ex.manifest.name;
    els.view.value = ex.manifest.view;
    els.description.value = ex.manifest.description ?? "";
    els.compile.disabled = false;
    if (els.exampleNote) els.exampleNote.textContent = ex.note;
    renderDiagnostics([]);
    if (say) info(els.note, `loaded ${ex.manifest.name}`);
  };
  /**
   * A program from the machine (D5). With a source, the box gets the text and a launch of the
   * edited copy keeps the inputs by hash; without one, the module itself is loaded and a launch
   * runs it as it is with the params on the right.
   */
  const loadMachineProgram = async (bundle: string): Promise<void> => {
    const p = machinePrograms.find((x) => x.bundle === bundle);
    if (!p) return;
    status(`loading ${p.name} from the store…`, "wait");
    try {
      const base = host.storeBase();
      if (!base) throw new Error("not connected to the machine");
      const { manifest, moduleHash, inputRefs } = await loadBundle(base, bundle);
      els.name.value = `${manifest.name}-edit`.slice(0, 64);
      els.view.value = manifest.view;
      els.description.value = manifest.description ?? "";
      els.params.value = JSON.stringify(manifest.defaultParams);
      renderDiagnostics([]);
      const inputsNote = inputRefs.length
        ? ` · ${inputRefs.length} input ${inputRefs.length === 1 ? "file" : "files"} kept by hash, nothing to re-upload`
        : "";
      if (manifest.source) {
        const source = await fetchBlob(base, manifest.source);
        els.source.value = new TextDecoder().decode(source);
        els.compile.disabled = false;
        module = { kind: "none" };
        els.launch.disabled = true;
        info(els.moduleInfo, "compile to get a module, then launch");
        if (els.exampleNote)
          els.exampleNote.textContent = `from the machine · source loaded (${fmtBytes(source.length)})${inputsNote} · edit, compile, launch as ${els.name.value}`;
        status(`${p.name} loaded from the store`, "live");
      } else {
        const wasm = await fetchBlob(base, moduleHash);
        els.source.value = `// ${manifest.name} has no source: it was dropped as a .wasm.\n// Its module is loaded; launch runs it as it is with the params on the right.`;
        els.compile.disabled = true;
        await showModule({ kind: "dropped", bytes: wasm });
        if (els.exampleNote)
          els.exampleNote.textContent = `from the machine · no source (a dropped .wasm)${inputsNote} · launch runs the module as it is`;
        status(`${p.name}'s module loaded from the store`, "live");
      }
      loaded = {
        kind: "machine",
        bundle,
        name: manifest.name,
        inputRefs,
        hasSource: !!manifest.source,
      };
    } catch (err) {
      status("compiler: idle", "");
      info(
        els.note,
        `could not open ${p.name}: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  };
  /** The select is rebuilt only when the machine's list changed, and keeps its selection. */
  function rebuildSelect(): void {
    if (!els.example) return;
    const sig = machinePrograms
      .map((p) => `${p.bundle}:${p.name}:${p.view}:${p.source ?? ""}`)
      .join("|");
    if (sig === machineListSig && els.example.childElementCount > 0) return;
    machineListSig = sig;
    const selected = els.example.value;
    els.example.replaceChildren();
    if (machinePrograms.length > 0) {
      const onMachine = document.createElement("optgroup");
      onMachine.label = "on the machine";
      for (const p of machinePrograms) {
        const o = document.createElement("option");
        o.value = `machine:${p.bundle}`;
        o.textContent = `${p.name} · ${p.view ?? "view unknown"}${p.source ? "" : " · no source"}`;
        onMachine.append(o);
      }
      els.example.append(onMachine);
    }
    const group = document.createElement("optgroup");
    group.label = "examples";
    for (const ex of all) {
      const o = document.createElement("option");
      o.value = ex.key;
      o.textContent = ex.label;
      group.append(o);
    }
    els.example.append(group);
    els.example.value = [...els.example.options].some((o) => o.value === selected)
      ? selected
      : loaded.kind === "example"
        ? loaded.key
        : "mandelbrot";
  }
  if (els.example) {
    rebuildSelect();
    els.example.onchange = () => {
      const v = els.example?.value ?? "mandelbrot";
      if (v.startsWith("machine:")) void loadMachineProgram(v.slice("machine:".length));
      else loadExample(v, true);
    };
    if (els.exampleNote) els.exampleNote.textContent = all[0]?.note ?? "";
  }
  els.reset.onclick = () => {
    if (loaded.kind === "machine") {
      void loadMachineProgram(loaded.bundle);
      info(els.note, `source reset to ${loaded.name} as the machine has it`);
      return;
    }
    const key = loaded.key;
    loadExample(key, false);
    info(els.note, `source reset to ${all.find((e) => e.key === key)?.manifest.name ?? key}`);
  };
  // The machine's programs arrive with the first snapshot; subscribe from the start.
  if (!unsubscribe) unsubscribe = host.subscribe(onCluster);
  // Editing after a compile: the module no longer matches the text, so launch waits for a fresh
  // compile and the module line says why.
  els.source.oninput = () => {
    if (module.kind !== "compiled") return;
    const stale = els.source.value !== module.source;
    els.launch.disabled = stale || host.demo === true;
    if (stale)
      info(els.moduleInfo, "the source changed since the compile; compile again to launch it");
    else void showModule(module);
  };
  els.source.onkeydown = (e) => {
    // Tab inserts two spaces; Shift+Tab leaves the field backwards and Escape leaves it forwards,
    // so a keyboard user can get out of the box.
    if (e.key === "Escape") {
      els.compile.focus();
      return;
    }
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: t, value } = els.source;
      els.source.value = `${value.slice(0, s)}  ${value.slice(t)}`;
      els.source.setSelectionRange(s + 2, s + 2);
    }
  };
  els.close.onclick = () => handle.close();
  status("compiler: idle (loads on first compile)");
  // Preloaded so the first compile is quick; a failure here is reported again by that compile.
  void compiler.warm().catch(() => undefined);

  const handle: EditorHandle = {
    get module() {
      return module.kind === "none" ? null : module.bytes;
    },
    get lastCompile() {
      return lastCompile;
    },
    get compilerLoadMs() {
      return compiler.loadMs;
    },
    compile,
    launch: launchModule,
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
