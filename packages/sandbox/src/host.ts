import type { HostRequest, TaskResult } from "./types.ts";

/**
 * The orchestrator's side of a sandbox worker, independent of the worker primitive: browsers
 * and Node each wrap their own worker in this shape (design §4.2).
 */
export interface WorkerLike {
  postMessage(msg: unknown): void;
  terminate(): void;
  onMessage(handler: (msg: unknown) => void): void;
  onError(handler: (err: unknown) => void): void;
}

export interface SandboxHost {
  /**
   * Run one task with a deadline. Past the deadline the worker is terminated outright — the only
   * clean way to stop a spinning loop — and the result is `{ok: false, error: "deadline"}`.
   */
  run(module: WebAssembly.Module, request: HostRequest, deadlineMs: number): Promise<TaskResult>;
  /** Terminate the worker, if any. */
  dispose(): void;
}

export interface TaskMessage {
  type: "task";
  id: number;
  module: WebAssembly.Module;
  request: HostRequest;
  /** Where the worker fetches blobs by hash; the web adapter's worker needs it, the node one has the bridge. */
  storeBase?: string;
}

export interface ResultMessage {
  type: "result";
  id: number;
  result: TaskResult;
}

export interface SandboxHostOptions {
  /** Messages that are not results — how the node adapter services blob requests. */
  onOther?: (msg: unknown) => void;
  /** Stamped on every task message. */
  storeBase?: string;
}

/**
 * A host that spawns a worker lazily, reuses it across tasks, serializes tasks, and replaces the
 * worker after a deadline kill or a crash.
 */
export function createSandboxHost(
  spawn: () => WorkerLike,
  opts: SandboxHostOptions = {},
): SandboxHost {
  let worker: WorkerLike | null = null;
  let nextId = 1;
  let disposed = false;
  let chain: Promise<unknown> = Promise.resolve();
  let pending: {
    id: number;
    settle: (r: TaskResult) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  function ensureWorker(): WorkerLike {
    if (worker) return worker;
    const w = spawn();
    w.onMessage((msg) => {
      const m = msg as Partial<ResultMessage>;
      if (m?.type === "result" && pending && m.id === pending.id && m.result) {
        finish(m.result);
        return;
      }
      opts.onOther?.(msg);
    });
    w.onError((err) => {
      // A worker we already replaced (deadline kill, dispose) reports its exit late; ignore it.
      if (worker !== w) return;
      worker = null;
      if (pending) finish({ ok: false, error: `worker error: ${errorText(err)}`, log: "" });
    });
    worker = w;
    return w;
  }

  function finish(result: TaskResult): void {
    if (!pending) return;
    clearTimeout(pending.timer);
    const { settle } = pending;
    pending = null;
    settle(result);
  }

  function runOne(
    module: WebAssembly.Module,
    request: HostRequest,
    deadlineMs: number,
  ): Promise<TaskResult> {
    return new Promise<TaskResult>((resolve) => {
      if (disposed) {
        resolve({ ok: false, error: "disposed", log: "" });
        return;
      }
      const w = ensureWorker();
      const id = nextId++;
      const timer = setTimeout(() => {
        w.terminate();
        if (worker === w) worker = null;
        finish({ ok: false, error: "deadline", log: "" });
      }, deadlineMs);
      pending = { id, settle: resolve, timer };
      const message: TaskMessage = { type: "task", id, module, request };
      if (opts.storeBase !== undefined) message.storeBase = opts.storeBase;
      w.postMessage(message);
    });
  }

  return {
    run(module, request, deadlineMs) {
      const next = chain.then(() => runOne(module, request, deadlineMs));
      chain = next.catch(() => undefined);
      return next;
    },
    dispose() {
      disposed = true;
      const w = worker;
      worker = null;
      w?.terminate();
      if (pending) finish({ ok: false, error: "disposed", log: "" });
    },
  };
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err)
    return String((err as { message: unknown }).message);
  return String(err);
}
