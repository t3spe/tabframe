// The page's side of the compiler worker: loaded on first use, one pending map, a timeout per
// compile, and a fresh worker after a death or a hang.
import type { CompileResult, WorkerReply, WorkerRequest } from "./compiler-types.ts";
import { ASC_FLAGS, assembleSources } from "./editor-core.ts";

/** A compile the worker never answers is failed after this long, and the hung worker goes with it. */
export const COMPILE_TIMEOUT_MS = 120_000;

export type StatusTone = "wait" | "live" | "off" | "";

/** The part of a `Worker` the client uses; a test passes a fake. */
export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent<WorkerReply>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  onmessageerror: ((ev: MessageEvent) => void) | null;
}

export interface CompilerClientDeps {
  onStatus(text: string, tone: StatusTone): void;
  createWorker?: (url: string) => WorkerLike;
  timeoutMs?: number;
  now?: () => number;
}

const failed = (message: string): CompileResult => ({
  ok: false,
  wasm: null,
  diagnostics: [],
  stderr: message,
  ms: 0,
});

export class CompilerClient {
  private readonly url: string;
  private readonly deps: CompilerClientDeps;
  private readonly createWorker: (url: string) => WorkerLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private worker: WorkerLike | null = null;
  private ready: Promise<string> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, (r: CompileResult) => void>();
  /** How long the worker took to report ready; null until it has. */
  loadMs: number | null = null;

  constructor(url: string, deps: CompilerClientDeps) {
    this.url = url;
    this.deps = deps;
    this.createWorker =
      deps.createWorker ?? ((u) => new Worker(u, { type: "module", name: "tabframe-compiler" }));
    this.timeoutMs = deps.timeoutMs ?? COMPILE_TIMEOUT_MS;
    this.now = deps.now ?? (() => performance.now());
  }

  /** Start the worker if it is not running; resolves with the compiler's version once it is ready. */
  warm(): Promise<string> {
    if (this.ready) return this.ready;
    const started = this.now();
    this.deps.onStatus("compiler: loading…", "wait");
    this.ready = new Promise<string>((resolve, reject) => {
      const w = this.createWorker(this.url);
      this.worker = w;
      w.onmessage = (ev) => {
        const msg = ev.data;
        if (msg.type === "ready") {
          this.loadMs = Math.round(this.now() - started);
          this.deps.onStatus(
            `compiler ${msg.version} ready in ${(this.loadMs / 1000).toFixed(1)} s`,
            "live",
          );
          resolve(msg.version);
          return;
        }
        if (msg.type === "compiled") {
          const settle = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          const { type: _t, id: _id, ...result } = msg;
          settle?.(result);
        }
      };
      // Every compile the dead worker owed is answered, or the compile button stays disabled for
      // the life of the tab; the next compile gets a fresh worker.
      const died = (message: string) => {
        this.deps.onStatus(`compiler failed: ${message}`, "off");
        w.terminate();
        this.ready = null;
        this.worker = null;
        for (const [, settle] of this.pending) settle(failed(message));
        this.pending.clear();
        reject(new Error(message));
      };
      w.onerror = (e) => died(e.message || "worker error");
      w.onmessageerror = () => died("the compiler sent an unreadable message");
    });
    return this.ready;
  }

  /** Compile `source` against the SDK; never throws for a bad program, only for a lost worker. */
  async compile(source: string): Promise<CompileResult> {
    await this.warm();
    return new Promise((resolve, reject) => {
      const w = this.worker;
      if (!w) return reject(new Error("no compiler worker"));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        if (this.worker === w) {
          w.terminate();
          this.worker = null;
          this.ready = null;
        }
        reject(new Error("the compiler did not answer within two minutes"));
      }, this.timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      const req: WorkerRequest = {
        type: "compile",
        id,
        fs: assembleSources(source),
        flags: [...ASC_FLAGS],
      };
      w.postMessage(req);
    });
  }
}
