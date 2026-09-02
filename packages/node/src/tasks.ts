import {
  type Assign,
  encodeRunInput,
  type FsManifest,
  fsManifest,
  LIMITS,
  PROTOCOL_VERSION,
  RELEASED,
  type Result,
} from "@tabframe/protocol";
import type { HostRequest, TaskResult } from "@tabframe/sandbox";
import type { PresignRequester, StoreClient } from "@tabframe/store";

/** The sandbox as the orchestrator sees it (design §4.2): one call, one deadline, a kill switch. */
export interface SandboxRunner {
  run(module: WebAssembly.Module, request: HostRequest, deadlineMs: number): Promise<TaskResult>;
  dispose(): void;
}

export interface TaskRunnerDeps {
  store: StoreClient;
  createSandbox(): SandboxRunner;
  compile(bytes: Uint8Array): Promise<WebAssembly.Module>;
  now(): number;
  log?: ((event: string, fields?: Record<string, unknown>) => void) | undefined;
}

const EMPTY_MANIFEST: FsManifest = { version: 1, files: {} };
const MAX_CACHED_MODULES = 8;
const MAX_CACHED_MANIFESTS = 32;

export type Outcome =
  | { kind: "result"; msg: Omit<Result, "v" | "gen"> }
  | { kind: "dropped"; reason: string };

/**
 * Runs one task end to end: module and manifest by hash (cached), ABI framing, the sandbox with
 * the deadline plus a grace second, then output, writes, and log uploaded through the store so
 * the result carries only hashes the store vouches for (design §4.1, §7.3).
 */
export class TaskRunner {
  private readonly deps: TaskRunnerDeps;
  private readonly modules = new Map<string, Promise<WebAssembly.Module>>();
  private readonly manifests = new Map<string, Promise<FsManifest>>();
  private sandbox: SandboxRunner | null = null;
  private current: string | null = null;

  constructor(deps: TaskRunnerDeps) {
    this.deps = deps;
  }

  get runningTaskId(): string | null {
    return this.current;
  }

  /** Kill whatever is running; the next task gets a fresh sandbox. */
  abort(): void {
    this.sandbox?.dispose();
    this.sandbox = null;
  }

  async run(a: Assign, gen: number): Promise<Outcome> {
    this.current = a.taskId;
    try {
      const [module, manifest] = await Promise.all([
        this.module(a.program),
        this.manifest(a.fsRoot),
      ]);
      const input =
        a.kind === "run"
          ? encodeRunInput({
              stage: a.stage,
              taskIndex: a.index,
              taskCount: a.count,
              input: fromBase64(a.input),
            })
          : fromBase64(a.input);
      const request: HostRequest = { kind: a.kind, input, manifest, limits: a.limits };
      if (!this.sandbox) this.sandbox = this.deps.createSandbox();
      const sandbox = this.sandbox;
      const started = this.deps.now();
      const result = await sandbox.run(module, request, a.deadlineMs + 1_000);
      // The wire wants whole milliseconds; the sandbox measures with a high-resolution clock.
      const computeMs = Math.max(0, Math.round(this.deps.now() - started));
      if (!result.ok) {
        if (result.error === "disposed") return { kind: "dropped", reason: "cancelled" };
        // A deadline kill is the node giving up, not a program fault; the control plane releases
        // it. So is a host that could not even instantiate the module — a CI runner with ten
        // workers failed `WebAssembly.Instance(): Out of memory` once and took a whole frame down
        // with it (WP4.4): the program did nothing wrong, another node will run the task.
        const error =
          result.error === "deadline" || hostFailure(result.error)
            ? RELEASED
            : result.error.slice(0, 1024);
        return {
          kind: "result",
          msg: {
            t: "result",
            taskId: a.taskId,
            attempt: a.attempt,
            error,
            writes: [],
            log: inlineLog(result.log),
            computeMs,
          },
        };
      }
      const uploads = await this.deps.store.putMany([
        result.output,
        ...result.writes.values(),
        ...(result.log.length > LIMITS.maxInlineLogBytes
          ? [new TextEncoder().encode(result.log)]
          : []),
      ]);
      const output = uploads[0] as { hash: string; size: number };
      const writes = [...result.writes.keys()].map((path, i) => {
        const up = uploads[i + 1] as { hash: string; size: number };
        return { path, hash: up.hash, size: up.size };
      });
      const log =
        result.log.length > LIMITS.maxInlineLogBytes
          ? { hash: (uploads[uploads.length - 1] as { hash: string }).hash }
          : inlineLog(result.log);
      return {
        kind: "result",
        msg: {
          t: "result",
          taskId: a.taskId,
          attempt: a.attempt,
          output: output.hash,
          outputSize: output.size,
          writes,
          log,
          computeMs: Math.max(Math.round(result.computeMs), 1),
        },
      };
    } catch (err) {
      this.deps.log?.("task-failed", { taskId: a.taskId, error: String(err) });
      return {
        kind: "result",
        msg: {
          t: "result",
          taskId: a.taskId,
          attempt: a.attempt,
          error: `node: ${String(err).slice(0, 200)}`,
          writes: [],
          log: null,
          computeMs: 0,
        },
      };
    } finally {
      this.current = null;
      void gen;
    }
  }

  private module(hash: string): Promise<WebAssembly.Module> {
    let p = this.modules.get(hash);
    if (!p) {
      p = this.deps.store.get(hash).then((bytes) => {
        if (!bytes) throw new Error(`program ${hash.slice(0, 12)} not in the store`);
        return this.deps.compile(bytes);
      });
      p.catch(() => this.modules.delete(hash));
      this.modules.set(hash, p);
      if (this.modules.size > MAX_CACHED_MODULES)
        this.modules.delete(this.modules.keys().next().value as string);
    }
    return p;
  }

  private manifest(root: string | null): Promise<FsManifest> {
    if (!root) return Promise.resolve(EMPTY_MANIFEST);
    let p = this.manifests.get(root);
    if (!p) {
      p = this.deps.store.get(root).then((bytes) => {
        if (!bytes) throw new Error(`manifest ${root.slice(0, 12)} not in the store`);
        return fsManifest.parse(JSON.parse(new TextDecoder().decode(bytes)));
      });
      p.catch(() => this.manifests.delete(root));
      this.manifests.set(root, p);
      if (this.manifests.size > MAX_CACHED_MANIFESTS)
        this.manifests.delete(this.manifests.keys().next().value as string);
    }
    return p;
  }
}

/** An error from the host, not from the program: the module never ran (memory, instantiation). */
export function hostFailure(error: string): boolean {
  return /out of memory|cannot allocate|WebAssembly\.(Instance|Memory)\(\)|RangeError: WebAssembly/i.test(
    error,
  );
}

function inlineLog(text: string): { text: string } | null {
  return text.length === 0 ? null : { text: text.slice(0, LIMITS.maxInlineLogBytes) };
}

/** Presign over the node socket (D18): one outstanding request at a time, matched by hash set. */
export class SocketPresigner implements PresignRequester {
  private readonly send: (text: string) => void;
  private waiting: {
    hashes: Set<string>;
    resolve: (
      v: Array<{ hash: string; url: string | null; headers: Record<string, string> }>,
    ) => void;
    reject: (e: Error) => void;
  } | null = null;
  private gen = 0;

  constructor(send: (text: string) => void) {
    this.send = send;
  }

  setGeneration(gen: number): void {
    this.gen = gen;
  }

  presign(
    items: Array<{ hash: string; size: number }>,
  ): Promise<Array<{ hash: string; url: string | null; headers: Record<string, string> }>> {
    return new Promise((resolve, reject) => {
      if (this.waiting) {
        reject(new Error("a presign is already outstanding"));
        return;
      }
      this.waiting = { hashes: new Set(items.map((i) => i.hash)), resolve, reject };
      this.send(JSON.stringify({ t: "presign", v: PROTOCOL_VERSION, gen: this.gen, items }));
    });
  }

  /** Feed the `presigned` message; returns true when it satisfied the outstanding request. */
  deliver(
    urls: Array<{ hash: string; url: string | null; headers: Record<string, string> }>,
  ): boolean {
    const w = this.waiting;
    if (!w) return false;
    if (!urls.every((u) => w.hashes.has(u.hash))) return false;
    this.waiting = null;
    w.resolve(urls);
    return true;
  }

  /** The socket died: fail the outstanding request. */
  reset(): void {
    const w = this.waiting;
    this.waiting = null;
    w?.reject(new Error("socket closed"));
  }
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Uint8Array(128);
for (let i = 0; i < B64.length; i++) LOOKUP[B64.charCodeAt(i)] = i;
export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      ((LOOKUP[clean.charCodeAt(i)] ?? 0) << 18) |
      ((LOOKUP[clean.charCodeAt(i + 1)] ?? 0) << 12) |
      ((LOOKUP[clean.charCodeAt(i + 2)] ?? 0) << 6) |
      (LOOKUP[clean.charCodeAt(i + 3)] ?? 0);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}
