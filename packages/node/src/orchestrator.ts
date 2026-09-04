import {
  type Assign,
  CLOSE,
  type Command,
  type ControlPlaneToNode,
  controlPlaneToNode,
  decode,
  encode,
  type Heartbeat,
  type Hello,
  LIMITS,
  type NodeKind,
  PROTOCOL_VERSION,
  type RotatingReason,
} from "@tabframe/protocol";
import { StoreClient } from "@tabframe/store";
import { Backoff } from "./backoff.ts";
import { type FetchLike, fetchSession, type Session, socketProtocols } from "./session.ts";
import { type SandboxRunner, SocketPresigner, TaskRunner } from "./tasks.ts";

/** The WHATWG surface the orchestrator needs; browser and Node WebSockets both provide it. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type NodeState =
  | "connecting"
  | "idle"
  | "busy"
  | "frozen"
  | "throttled"
  | "closed"
  | "off"
  | "outdated";

export interface Status {
  state: NodeState;
  nodeId: string | null;
  generation: number | null;
  endpoint: string | null;
  tasksDone: number;
  lastTaskMs: number | null;
  attempts: number;
  /** Tasks accepted and not yet finished, the running one included. */
  queue: number;
  detail?: string;
}

export interface OrchestratorDeps {
  sessionUrl: string;
  hostId: string;
  /** A cloud core's proof of identity (WP8.2); tabs have none. */
  coreToken?: string;
  kind: NodeKind;
  cores: number;
  sandboxVersion: string;
  fetch: FetchLike;
  connect: (url: string, protocols?: string[]) => SocketLike;
  timers: Timers;
  /** The platform's sandbox for a store base (a Web Worker or a worker thread). */
  createSandbox: (storeBase: string) => SandboxRunner;
  /** Blob traffic: GET by hash and presigned PUT. Defaults to the global fetch. */
  blobFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  compile?: (bytes: Uint8Array) => Promise<WebAssembly.Module>;
  now?: () => number;
  rng?: () => number;
  onStatus: (status: Status) => void;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

/** How much slower a throttled node runs: it idles this many times its compute after each task. */
export const THROTTLE_FACTOR = 9;
/** A throttled node idles at least this long between tasks, so tiny tasks still slow down. */
export const THROTTLE_MIN_MS = 50;

/**
 * The orchestrator (design §4): handshake, heartbeat, reconnect through the session function with
 * backoff or the rotation delay, and the task loop — accept up to `maxInFlight` assignments, run
 * them one at a time through the sandbox, upload what they produced, report. Commands from the
 * dashboard (close, freeze, throttle, resume) act on this loop.
 */
/** How often a node facing an off machine asks the session again (WP8.2). */
export const OFF_POLL_MS = 15_000;
export class Orchestrator {
  private socket: SocketLike | null = null;
  private session: (Session & { kind: "on" }) | null = null;
  private nodeId: string | null = null;
  private heartbeatMs: number = LIMITS.heartbeatMs;
  private heartbeatHandle: unknown = null;
  private reconnectHandle: unknown = null;
  private throttleHandle: unknown = null;
  private stopped = false;
  private visible = true;
  private attempts = 0;
  private readonly backoff: Backoff;
  private readonly deps: OrchestratorDeps;
  private tasksDone = 0;
  private lastTaskMs: number | null = null;

  private maxInFlight: number = LIMITS.maxInFlight;
  private queue: Assign[] = [];
  private running: Assign | null = null;
  private frozen = false;
  private throttled = false;
  private runner: TaskRunner | null = null;
  private runnerBase: string | null = null;
  private readonly presigner = new SocketPresigner((text) => this.socket?.send(text));

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.backoff = new Backoff(deps.rng ?? Math.random);
  }

  get currentNodeId(): string | null {
    return this.nodeId;
  }

  /** Begin the connect loop. Resolves once the first connection attempt is underway. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connectOnce();
  }

  /** Leave for good: no reconnect. Looks like a tab close to the control plane. */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.dropWork();
    this.presigner.reset();
    this.socket?.close(1000, "stop");
    this.socket = null;
    this.status("closed");
  }

  /** The host tab reports its visibility; the next heartbeat carries it. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.socket && this.nodeId) this.status(this.state());
  }

  private async connectOnce(): Promise<void> {
    if (this.stopped) return;
    this.attempts++;
    this.status("connecting");
    let session: Session;
    try {
      session = await fetchSession(this.deps.sessionUrl, this.deps.fetch);
    } catch (err) {
      this.deps.log?.("session-failed", { error: String(err) });
      return this.scheduleReconnect(this.backoff.next());
    }
    if (session.kind === "off") {
      // Asked again every so often (WP8.2): a node that lived through `down` and `up` used to
      // stay "off" beside a live dashboard until the tab was reloaded.
      this.status("off", "the machine is off");
      return this.scheduleReconnect(OFF_POLL_MS);
    }
    if (session.kind === "starting") {
      this.status("connecting", "control plane starting");
      return this.scheduleReconnect(session.retryAfterMs);
    }
    this.session = session;
    this.presigner.setGeneration(session.generation);
    const url = `${session.endpoint.replace(/\/$/, "")}/node`;
    const socket = this.deps.connect(url, socketProtocols(session.token));
    this.socket = socket;
    socket.onopen = () => this.onOpen();
    socket.onmessage = (ev) => this.onMessage(ev.data);
    socket.onclose = (ev) => this.onClose(ev.code, ev.reason);
    socket.onerror = () => {
      /* the close event carries the outcome */
    };
  }

  private onOpen(): void {
    if (!this.session) return;
    const hello: Hello = {
      t: "hello",
      v: PROTOCOL_VERSION,
      gen: this.session.generation,
      hostId: this.deps.hostId,
      kind: this.deps.kind,
      cores: this.deps.cores,
      sandboxVersion: this.deps.sandboxVersion,
      ...(this.deps.coreToken ? { coreToken: this.deps.coreToken } : {}),
    };
    this.socket?.send(encode(hello));
  }

  private onMessage(data: unknown): void {
    if (!this.session) return;
    const d = decode(controlPlaneToNode, data, { expectGen: this.session.generation });
    if (!d.ok) {
      this.deps.log?.("bad-message", { reason: d.reason });
      this.socket?.close(d.closeCode, d.reason.slice(0, 120));
      return;
    }
    this.handle(d.msg);
  }

  private handle(msg: ControlPlaneToNode): void {
    switch (msg.t) {
      case "welcome": {
        this.nodeId = msg.nodeId;
        this.heartbeatMs = msg.heartbeatMs;
        this.maxInFlight = msg.maxInFlight;
        this.ensureRunner(resolveStoreBase(msg.storeBase, this.session?.endpoint ?? ""));
        this.backoff.reset();
        this.status(this.state());
        this.scheduleHeartbeat();
        return;
      }
      case "assign":
        this.onAssign(msg);
        return;
      case "cancel":
        this.queue = this.queue.filter((a) => a.taskId !== msg.taskId);
        if (this.running?.taskId === msg.taskId) this.runner?.abort();
        this.status(this.state());
        return;
      case "command":
        this.onCommand(msg);
        return;
      case "presigned":
        if (!this.presigner.deliver(msg.urls)) this.deps.log?.("stray-presigned");
        return;
    }
  }

  private onAssign(a: Assign): void {
    if (this.frozen) {
      this.deps.log?.("assign-while-frozen", { taskId: a.taskId });
      return;
    }
    const held = this.queue.length + (this.running ? 1 : 0);
    if (held >= this.maxInFlight) {
      this.deps.log?.("assign-over-capacity", { taskId: a.taskId, held });
      return;
    }
    this.queue.push(a);
    this.pump();
    this.status(this.state());
  }

  private onCommand(msg: Command): void {
    switch (msg.op) {
      case "close":
        this.stop();
        return;
      case "freeze":
        // Looks dead to the control plane: no heartbeats, no results, socket left open.
        this.frozen = true;
        this.deps.timers.clearTimeout(this.heartbeatHandle);
        this.dropWork();
        this.status("frozen", "frozen by an operator");
        return;
      case "throttle":
        this.throttled = true;
        this.status(this.state(), "throttled by an operator");
        return;
      case "resume":
        this.frozen = false;
        this.throttled = false;
        this.deps.timers.clearTimeout(this.throttleHandle);
        this.throttleHandle = null;
        this.scheduleHeartbeat();
        this.pump();
        this.status(this.state());
        return;
    }
  }

  private ensureRunner(storeBase: string): void {
    if (this.runner && this.runnerBase === storeBase) return;
    this.runner?.abort();
    const blobFetch = this.deps.blobFetch ?? ((u, i) => fetch(u, i));
    const store = new StoreClient(storeBase, this.presigner, blobFetch);
    this.runner = new TaskRunner({
      store,
      createSandbox: () => this.deps.createSandbox(storeBase),
      compile: this.deps.compile ?? ((bytes) => WebAssembly.compile(bytes as BufferSource)),
      now: this.deps.now ?? (() => Date.now()),
      log: this.deps.log,
    });
    this.runnerBase = storeBase;
  }

  /** Start the next queued task unless one is running, the node is paused, or nothing waits. */
  private pump(): void {
    if (this.running || this.frozen || this.throttleHandle || this.stopped) return;
    const next = this.queue.shift();
    if (!next || !this.runner) return;
    this.running = next;
    const socket = this.socket;
    const gen = this.session?.generation ?? 0;
    void this.runner.run(next, gen).then((outcome) => {
      if (this.running !== next) return; // dropped meanwhile
      this.running = null;
      if (outcome.kind === "result") {
        this.tasksDone += 1;
        this.lastTaskMs = outcome.msg.computeMs;
        // A result only has a path while the socket that assigned the task is still up.
        if (socket && socket === this.socket && this.nodeId) {
          socket.send(encode({ ...outcome.msg, v: PROTOCOL_VERSION, gen }));
        }
        if (this.throttled) {
          const idle = Math.max(outcome.msg.computeMs * THROTTLE_FACTOR, THROTTLE_MIN_MS);
          this.throttleHandle = this.deps.timers.setTimeout(() => {
            this.throttleHandle = null;
            this.pump();
            this.status(this.state());
          }, idle);
          this.status(this.state());
          return;
        }
      }
      this.pump();
      this.status(this.state());
    });
  }

  /** Forget queued work and kill the running task; the control plane reassigns it. */
  private dropWork(): void {
    this.queue = [];
    this.running = null;
    this.runner?.abort();
    this.deps.timers.clearTimeout(this.throttleHandle);
    this.throttleHandle = null;
  }

  private state(): NodeState {
    if (this.frozen) return "frozen";
    if (this.throttled || !this.visible) return "throttled";
    return this.running ? "busy" : "idle";
  }

  private scheduleHeartbeat(): void {
    this.deps.timers.clearTimeout(this.heartbeatHandle);
    this.heartbeatHandle = this.deps.timers.setTimeout(() => {
      this.sendHeartbeat();
      this.scheduleHeartbeat();
    }, this.heartbeatMs);
  }

  private sendHeartbeat(): void {
    if (!this.socket || !this.session || !this.nodeId || this.frozen) return;
    const hb: Heartbeat = {
      t: "heartbeat",
      v: PROTOCOL_VERSION,
      gen: this.session.generation,
      visible: this.visible,
      queue: Math.min(this.held(), LIMITS.maxInFlight),
      lastTaskMs: this.lastTaskMs,
      tasksDone: this.tasksDone,
    };
    this.socket.send(encode(hb));
  }

  private held(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  private onClose(code: number, reason: string): void {
    this.deps.timers.clearTimeout(this.heartbeatHandle);
    this.socket = null;
    this.nodeId = null;
    this.presigner.reset();
    // Assignments belong to the connection; the control plane releases them when we vanish.
    this.dropWork();
    this.frozen = false;
    this.throttled = false;
    if (this.stopped) return;
    if (code === CLOSE.versionMismatch) {
      this.status("outdated", "protocol version mismatch; reload");
      return;
    }
    let delay = this.backoff.next();
    if (code === CLOSE.rotatingReconnect) {
      const parsed = parseRotating(reason);
      if (parsed) delay = parsed.reconnectAfterMs;
    }
    this.deps.log?.("closed", { code, reason, reconnectInMs: delay });
    this.status("connecting", `reconnecting in ${Math.round(delay)} ms`);
    this.scheduleReconnect(delay);
  }

  private scheduleReconnect(delay: number): void {
    this.deps.timers.clearTimeout(this.reconnectHandle);
    this.reconnectHandle = this.deps.timers.setTimeout(() => void this.connectOnce(), delay);
  }

  private clearTimers(): void {
    this.deps.timers.clearTimeout(this.heartbeatHandle);
    this.deps.timers.clearTimeout(this.reconnectHandle);
    this.deps.timers.clearTimeout(this.throttleHandle);
    this.throttleHandle = null;
  }

  private status(state: NodeState, detail?: string): void {
    const s: Status = {
      state,
      nodeId: this.nodeId,
      generation: this.session?.generation ?? null,
      endpoint: this.session?.endpoint ?? null,
      tasksDone: this.tasksDone,
      lastTaskMs: this.lastTaskMs,
      attempts: this.attempts,
      queue: this.held(),
    };
    if (detail !== undefined) s.detail = detail;
    this.deps.onStatus(s);
  }
}

export function parseRotating(reason: string): RotatingReason | null {
  try {
    const r = JSON.parse(reason) as Partial<RotatingReason>;
    if (typeof r.reconnectAfterMs === "number" && r.reconnectAfterMs >= 0) {
      return { gen: r.gen ?? 0, next: r.next ?? 0, reconnectAfterMs: r.reconnectAfterMs };
    }
  } catch {
    /* not a rotating reason */
  }
  return null;
}

/**
 * A relative store base (`/blob`, local mode) lives on the control plane's own HTTP origin, which
 * the socket endpoint names; an absolute one (CloudFront) is used as is.
 */
export function resolveStoreBase(storeBase: string, endpoint: string): string {
  if (!storeBase.startsWith("/")) return storeBase.replace(/\/$/, "");
  const origin = endpoint.replace(/^ws/, "http").replace(/\/$/, "");
  if (!origin) return storeBase.replace(/\/$/, "");
  return new URL(storeBase, `${origin}/`).href.replace(/\/$/, "");
}
