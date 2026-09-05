import {
  type Assign,
  encodeRunInput,
  type FsManifest,
  fsManifest,
  LIMITS,
  RELEASED,
  type Result,
} from "@tabframe/protocol";
import type { HostRequest, TaskResult } from "@tabframe/sandbox";
import { type StoreClient, StoreError, type Uploaded } from "@tabframe/store";

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

/** The node's margin over the control plane's deadline; the fetches and the kill both run inside it. */
export const GRACE_MS = 1_000;

const EMPTY_MANIFEST: FsManifest = { version: 1, files: {} };
const MAX_CACHED_MODULES = 8;
const MAX_CACHED_MANIFESTS = 32;
/** Upload labels; write paths start with a slash, so these cannot collide with one. */
const OUTPUT = "output";
const LOG = "log";

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

  async run(a: Assign): Promise<Outcome> {
    this.current = a.taskId;
    try {
      // The deadline covers the fetches too: a module fetch that hangs would otherwise hold the
      // attempt for ever, and with one node the control plane has nobody else to give the task to.
      let overran: ReturnType<typeof setTimeout> | null = null;
      const fetched = await Promise.race([
        Promise.all([this.module(a.program), this.manifest(a.fsRoot)]),
        new Promise<null>((resolve) => {
          overran = setTimeout(() => resolve(null), a.deadlineMs + GRACE_MS);
        }),
      ]);
      if (overran) clearTimeout(overran);
      if (fetched === null) {
        this.deps.log?.("task-fetch-overran", { taskId: a.taskId, deadlineMs: a.deadlineMs });
        return failed(a, RELEASED, null, 0);
      }
      const [module, manifest] = fetched;
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
      const result = await sandbox.run(module, request, a.deadlineMs + GRACE_MS);
      // The wire wants whole milliseconds; the sandbox measures with a high-resolution clock.
      const computeMs = Math.max(0, Math.round(this.deps.now() - started));
      if (!result.ok) {
        if (result.error === "disposed") return { kind: "dropped", reason: "cancelled" };
        // A deadline kill, or a host that could not even instantiate the module, is the node
        // giving up, not a program fault: the control plane releases the task to another node.
        const error =
          result.error === "deadline" || hostFailure(result.error)
            ? RELEASED
            : result.error.slice(0, 1024);
        return failed(a, error, inlineLog(result.log), computeMs);
      }
      const bigLog = result.log.length > LIMITS.maxInlineLogBytes;
      const blobs = new Map<string, Uint8Array>([[OUTPUT, result.output], ...result.writes]);
      if (bigLog) blobs.set(LOG, new TextEncoder().encode(result.log));
      const uploaded = await this.deps.store.putNamed(blobs);
      const output = uploadOf(uploaded, OUTPUT);
      const writes = [...result.writes.keys()].map((path) => ({
        path,
        ...uploadOf(uploaded, path),
      }));
      const log = bigLog ? { hash: uploadOf(uploaded, LOG).hash } : inlineLog(result.log);
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
      const text = String(err);
      this.deps.log?.("task-failed", { taskId: a.taskId, error: text });
      // The store failing is the host's problem, whatever the message says; so is memory.
      const released = err instanceof StoreError || hostFailure(text);
      return failed(a, released ? RELEASED : `node: ${text.slice(0, 200)}`, null, 0);
    } finally {
      this.current = null;
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

/**
 * A sandbox failure that is the host's, not the program's: memory the host could not give. What
 * a program says about itself is a program fault whatever words it uses, or an abort saying
 * "out of memory" would be re-run on every node for ever.
 */
export function hostFailure(error: string): boolean {
  if (/^(abort|trap|link): /.test(error)) return false;
  return /out of memory|cannot allocate|WebAssembly\.(Instance|Memory)\(\)|RangeError: WebAssembly/i.test(
    error,
  );
}

function failed(
  a: Assign,
  error: string,
  log: { text: string } | null,
  computeMs: number,
): Outcome {
  return {
    kind: "result",
    msg: { t: "result", taskId: a.taskId, attempt: a.attempt, error, writes: [], log, computeMs },
  };
}

function uploadOf(uploaded: Map<string, Uploaded>, name: string): Uploaded {
  const u = uploaded.get(name);
  if (!u) throw new Error(`no upload for ${name}`);
  return u;
}

function inlineLog(text: string): { text: string } | null {
  return text.length === 0 ? null : { text: text.slice(0, LIMITS.maxInlineLogBytes) };
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
