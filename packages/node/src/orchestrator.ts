import {
  CLOSE,
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
import { Backoff } from "./backoff.ts";
import { type FetchLike, fetchSession, type Session, socketProtocols } from "./session.ts";

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
  detail?: string;
}

export interface OrchestratorDeps {
  sessionUrl: string;
  hostId: string;
  kind: NodeKind;
  cores: number;
  sandboxVersion: string;
  fetch: FetchLike;
  connect: (url: string, protocols?: string[]) => SocketLike;
  timers: Timers;
  rng?: () => number;
  onStatus: (status: Status) => void;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

/**
 * The orchestrator (design §4). This M0 version handshakes, heartbeats, reconnects through the
 * session function with backoff or the rotation delay, and reports status. Tasks arrive in M1.
 */
export class Orchestrator {
  private socket: SocketLike | null = null;
  private session: (Session & { kind: "on" }) | null = null;
  private nodeId: string | null = null;
  private heartbeatMs: number = LIMITS.heartbeatMs;
  private heartbeatHandle: unknown = null;
  private reconnectHandle: unknown = null;
  private stopped = false;
  private visible = true;
  private attempts = 0;
  private readonly backoff: Backoff;
  private readonly deps: OrchestratorDeps;
  private tasksDone = 0;
  private lastTaskMs: number | null = null;

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
    this.socket?.close(1000, "stop");
    this.socket = null;
    this.status("closed");
  }

  /** The host tab reports its visibility; the next heartbeat carries it. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.socket && this.nodeId) this.status(visible ? "idle" : "throttled");
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
      this.status("off", "the machine is off");
      return;
    }
    if (session.kind === "starting") {
      this.status("connecting", "control plane starting");
      return this.scheduleReconnect(session.retryAfterMs);
    }
    this.session = session;
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
      case "welcome":
        this.nodeId = msg.nodeId;
        this.heartbeatMs = msg.heartbeatMs;
        this.backoff.reset();
        this.status(this.visible ? "idle" : "throttled");
        this.scheduleHeartbeat();
        return;
    }
  }

  private scheduleHeartbeat(): void {
    this.deps.timers.clearTimeout(this.heartbeatHandle);
    this.heartbeatHandle = this.deps.timers.setTimeout(() => {
      this.sendHeartbeat();
      this.scheduleHeartbeat();
    }, this.heartbeatMs);
  }

  private sendHeartbeat(): void {
    if (!this.socket || !this.session || !this.nodeId) return;
    const hb: Heartbeat = {
      t: "heartbeat",
      v: PROTOCOL_VERSION,
      gen: this.session.generation,
      visible: this.visible,
      queue: 0,
      lastTaskMs: this.lastTaskMs,
      tasksDone: this.tasksDone,
    };
    this.socket.send(encode(hb));
  }

  private onClose(code: number, reason: string): void {
    this.deps.timers.clearTimeout(this.heartbeatHandle);
    this.socket = null;
    this.nodeId = null;
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
    this.scheduleReconnect(delay);
  }

  private scheduleReconnect(delay: number): void {
    this.deps.timers.clearTimeout(this.reconnectHandle);
    this.reconnectHandle = this.deps.timers.setTimeout(() => void this.connectOnce(), delay);
  }

  private clearTimers(): void {
    this.deps.timers.clearTimeout(this.heartbeatHandle);
    this.deps.timers.clearTimeout(this.reconnectHandle);
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
