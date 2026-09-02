import { Backoff } from "@tabframe/node/backoff";
import { fetchSession, type Session, socketProtocols } from "@tabframe/node/session";
import {
  CLOSE,
  type ControlPlaneToObserver,
  controlPlaneToObserver,
  decode,
  encode,
  LIMITS,
  PROTOCOL_VERSION,
} from "@tabframe/protocol";
import { applyMessage, type ClusterState, emptyState } from "./state.ts";

export type MachineState = "connecting" | "starting" | "off" | "live" | "outdated";

export interface ObserverHandlers {
  onState(machine: MachineState, detail?: string): void;
  onCluster(state: ClusterState): void;
  onSession(session: Session & { kind: "on" }): void;
}

/**
 * The observer socket: session → subscribe → snapshot and events, pinging every two seconds,
 * resubscribing on a sequence gap, reconnecting through a fresh session after any close.
 */
export class ObserverClient {
  private socket: WebSocket | null = null;
  private state: ClusterState = emptyState();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly backoff = new Backoff();
  private readonly sessionUrl: string;
  private readonly handlers: ObserverHandlers;

  constructor(sessionUrl: string, handlers: ObserverHandlers) {
    this.sessionUrl = sessionUrl;
    this.handlers = handlers;
  }

  get cluster(): ClusterState {
    return this.state;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.socket?.close(1000, "stop");
    this.socket = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.handlers.onState("connecting");
    let session: Session;
    try {
      session = await fetchSession(this.sessionUrl, (url) => fetch(url, { cache: "no-store" }));
    } catch {
      return this.later(this.backoff.next());
    }
    if (session.kind === "off") return this.handlers.onState("off");
    if (session.kind === "starting") {
      this.handlers.onState("starting");
      return this.later(session.retryAfterMs);
    }
    this.handlers.onSession(session);
    const ws = new WebSocket(
      `${session.endpoint.replace(/\/$/, "")}/observer`,
      socketProtocols(session.token),
    );
    this.socket = ws;
    ws.onopen = () => {
      ws.send(encode({ t: "subscribe", v: PROTOCOL_VERSION, gen: session.generation }));
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(encode({ t: "ping", v: PROTOCOL_VERSION, gen: session.generation }));
      }, LIMITS.observerPingMs);
    };
    ws.onmessage = (ev) => this.onMessage(ws, session, ev.data);
    ws.onclose = (ev) => this.onClose(ev.code, ev.reason);
  }

  private onMessage(ws: WebSocket, session: Session & { kind: "on" }, data: unknown): void {
    const d = decode(controlPlaneToObserver, data, { expectGen: session.generation });
    if (!d.ok) {
      ws.close(d.closeCode, d.reason.slice(0, 120));
      return;
    }
    this.state = applyMessage(this.state, d.msg as ControlPlaneToObserver);
    if (this.state.gap) {
      // Missed an event: ask for a fresh snapshot rather than trust a stale view.
      this.state = { ...this.state, gap: false };
      ws.send(
        encode({
          t: "subscribe",
          v: PROTOCOL_VERSION,
          gen: session.generation,
          since: this.state.seq,
        }),
      );
      return;
    }
    if (d.msg.t === "snapshot" && this.state.pagesPending === 0) this.handlers.onState("live");
    this.handlers.onCluster(this.state);
  }

  private onClose(code: number, reason: string): void {
    this.clearTimers();
    this.socket = null;
    if (this.stopped) return;
    if (code === CLOSE.versionMismatch) {
      this.handlers.onState("outdated", reason);
      return;
    }
    let delay = this.backoff.next();
    if (code === CLOSE.rotatingReconnect) {
      try {
        const r = JSON.parse(reason) as { reconnectAfterMs?: number };
        if (typeof r.reconnectAfterMs === "number") delay = r.reconnectAfterMs;
      } catch {
        /* fall back to backoff */
      }
      this.handlers.onState("connecting", "control plane rotating");
    }
    this.later(delay);
  }

  private later(ms: number): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.connect(), ms);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
  }
}
