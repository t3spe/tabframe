import {
  CLOSE,
  type ControlPlaneToNode,
  controlPlaneToNode,
  decode,
  encode,
  type Heartbeat,
  type Hello,
  LIMITS,
  PROTOCOL_VERSION,
  type RotatingReason,
} from "@tabframe/protocol";
import { Backoff } from "./backoff.ts";
import { type FetchLike, fetchSession, type Session, socketProtocols } from "./session.ts";

/** The WHATWG surface the node needs; browser and Node WebSockets both provide it. */
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

export type Log = (event: string, fields?: Record<string, unknown>) => void;

/** How often a node facing an off machine asks the session again. */
export const OFF_POLL_MS = 15_000;

export type Welcome = Extract<ControlPlaneToNode, { t: "welcome" }>;

/** A sender bound to one socket: it goes quiet once that socket is gone or replaced. */
export interface Link {
  readonly generation: number;
  send(text: string): void;
}

export interface ConnectionDeps {
  sessionUrl: string;
  fetch: FetchLike;
  connect: (url: string, protocols?: string[]) => SocketLike;
  timers: Timers;
  rng?: (() => number) | undefined;
  /** How this node introduces itself. */
  hello: () => Omit<Hello, "t" | "v" | "gen">;
  /** The heartbeat body, or null to stay silent. */
  heartbeat: () => Omit<Heartbeat, "t" | "v" | "gen"> | null;
  onWelcome: (msg: Welcome) => void;
  onMessage: (msg: Exclude<ControlPlaneToNode, Welcome>) => void;
  /** The socket is gone; whatever rode on it is void. A reconnect, if any, follows. */
  onClosed: () => void;
  onStatus: (state: "connecting" | "off" | "outdated", detail?: string) => void;
  log?: Log | undefined;
}

/**
 * The node's side of the socket (design §4, §8.1): the session fetch, the connect with the proxy's
 * subprotocols, the hello, the heartbeat, and the reconnect with backoff or the rotation delay.
 */
export class NodeConnection {
  private socket: SocketLike | null = null;
  private session: (Session & { kind: "on" }) | null = null;
  private id: string | null = null;
  private heartbeatMs: number = LIMITS.heartbeatMs;
  private heartbeatHandle: unknown = null;
  private reconnectHandle: unknown = null;
  private stopped = false;
  private tries = 0;
  private readonly backoff: Backoff;
  private readonly deps: ConnectionDeps;

  constructor(deps: ConnectionDeps) {
    this.deps = deps;
    this.backoff = new Backoff(deps.rng ?? Math.random);
  }

  /** The id the control plane welcomed this node with; null between sockets. */
  get nodeId(): string | null {
    return this.id;
  }

  get generation(): number | null {
    return this.session?.generation ?? null;
  }

  get endpoint(): string | null {
    return this.session?.endpoint ?? null;
  }

  get attempts(): number {
    return this.tries;
  }

  /** A socket is up, welcomed or not. */
  get connected(): boolean {
    return this.socket !== null;
  }

  /** Begin the connect loop. Resolves once the first connection attempt is underway. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connectOnce();
  }

  /** Leave for good: no reconnect. Looks like a tab close to the control plane. */
  stop(): void {
    this.stopped = true;
    this.deps.timers.clearTimeout(this.heartbeatHandle);
    this.deps.timers.clearTimeout(this.reconnectHandle);
    this.socket?.close(1000, "stop");
    this.socket = null;
  }

  send(text: string): void {
    this.socket?.send(text);
  }

  /** A sender for the current socket, or null without one. */
  link(): Link | null {
    const socket = this.socket;
    if (!socket) return null;
    return {
      generation: this.session?.generation ?? 0,
      send: (text) => {
        if (socket === this.socket && this.id) socket.send(text);
      },
    };
  }

  pauseHeartbeat(): void {
    this.deps.timers.clearTimeout(this.heartbeatHandle);
  }

  resumeHeartbeat(): void {
    this.scheduleHeartbeat();
  }

  private async connectOnce(): Promise<void> {
    if (this.stopped) return;
    this.tries++;
    this.deps.onStatus("connecting");
    let session: Session;
    try {
      session = await fetchSession(this.deps.sessionUrl, this.deps.fetch);
    } catch (err) {
      this.deps.log?.("session-failed", { error: String(err) });
      return this.scheduleReconnect(this.backoff.next());
    }
    if (session.kind === "off") {
      // Asked again every so often: a node that lived through `down` and `up` joins again
      // without a reload.
      this.deps.onStatus("off", "the machine is off");
      return this.scheduleReconnect(OFF_POLL_MS);
    }
    if (session.kind === "starting") {
      this.deps.onStatus("connecting", "control plane starting");
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
      ...this.deps.hello(),
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
    if (d.msg.t === "welcome") {
      this.id = d.msg.nodeId;
      this.heartbeatMs = d.msg.heartbeatMs;
      this.backoff.reset();
      this.deps.onWelcome(d.msg);
      this.scheduleHeartbeat();
      return;
    }
    this.deps.onMessage(d.msg);
  }

  private scheduleHeartbeat(): void {
    this.deps.timers.clearTimeout(this.heartbeatHandle);
    this.heartbeatHandle = this.deps.timers.setTimeout(() => {
      this.sendHeartbeat();
      this.scheduleHeartbeat();
    }, this.heartbeatMs);
  }

  private sendHeartbeat(): void {
    if (!this.socket || !this.session || !this.id) return;
    const body = this.deps.heartbeat();
    if (!body) return;
    const hb: Heartbeat = {
      t: "heartbeat",
      v: PROTOCOL_VERSION,
      gen: this.session.generation,
      ...body,
    };
    this.socket.send(encode(hb));
  }

  private onClose(code: number, reason: string): void {
    this.deps.timers.clearTimeout(this.heartbeatHandle);
    this.socket = null;
    this.id = null;
    this.deps.onClosed();
    if (this.stopped) return;
    if (code === CLOSE.versionMismatch) {
      this.deps.onStatus("outdated", "protocol version mismatch; reload");
      return;
    }
    let delay = this.backoff.next();
    if (code === CLOSE.rotatingReconnect) {
      const parsed = parseRotating(reason);
      if (parsed) delay = parsed.reconnectAfterMs;
    }
    this.deps.log?.("closed", { code, reason, reconnectInMs: delay });
    this.deps.onStatus("connecting", `reconnecting in ${Math.round(delay)} ms`);
    this.scheduleReconnect(delay);
  }

  private scheduleReconnect(delay: number): void {
    this.deps.timers.clearTimeout(this.reconnectHandle);
    this.reconnectHandle = this.deps.timers.setTimeout(() => void this.connectOnce(), delay);
  }
}

/** The close reason a rotating control plane sends, or null for any other reason. */
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
