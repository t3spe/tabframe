import { Backoff } from "@tabframe/node/backoff";
import { fetchSession, type Session, socketProtocols } from "@tabframe/node/session";
import {
  CLOSE,
  type Control,
  type ControlPlaneToObserver,
  controlPlaneToObserver,
  decode,
  encode,
  LIMITS,
  type ObserverToControlPlane,
  PROTOCOL_VERSION,
} from "@tabframe/protocol";
import type { PresignedUpload, PresignItem } from "@tabframe/store";
import { applyMessage, type ClusterState, emptyState, withRedundancy } from "./state.ts";

export type MachineState = "connecting" | "starting" | "off" | "live" | "outdated";

/** A control as the page issues it; the client stamps the version and generation. */
export type ControlRequest = Control extends infer C
  ? C extends { v: number; gen: number }
    ? Omit<C, "v" | "gen">
    : never
  : never;

export interface ObserverHandlers {
  onState(machine: MachineState, detail?: string): void;
  onCluster(state: ClusterState): void;
  onSession(session: Session & { kind: "on" }): void;
}

/** Anything the page sends besides subscribe and ping, before the version and generation are stamped. */
type Outgoing = ControlRequest | { t: "presign"; items: PresignItem[] };

/** How long a presign may stay unanswered before the upload gives up. */
export const PRESIGN_TIMEOUT_MS = 30_000;

/** Spacing between outgoing controls: with a ping every two seconds this stays under the observer rate. */
export const CONTROL_SPACING_MS = Math.ceil(1000 / (LIMITS.observerMessagesPerSecond - 1));

/**
 * A control issued while the socket is between subscribes — a silent resubscribe after a
 * sequence gap or a refresh, or the seconds of a rotation — is held for the next live socket this
 * long, then dropped: the machine a person clicked at a moment ago is the one they meant, a
 * machine that has been gone for longer is not (WP4.4: a demo run lost "kill half" this way).
 */
export const CONTROL_HOLD_MS = 10_000;
/** A quiet refresh spreads the reconnects of many observers over this many milliseconds. */
export const REFRESH_JITTER_MS = 4_000;

/**
 * The observer socket: session → subscribe → snapshot and events, pinging every two seconds,
 * reconnecting for a fresh snapshot on a sequence gap, and reconnecting through a fresh session
 * after any close. Controls go out spaced under the observer rate limit.
 */
export class ObserverClient {
  private socket: WebSocket | null = null;
  private session: (Session & { kind: "on" }) | null = null;
  private state: ClusterState = emptyState();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private off = false;
  private resubscribing = false;
  private lastSentAt = 0;
  private outbox: Outgoing[] = [];
  /** Controls issued between subscribes, with the moment each was asked for. */
  private held: Array<{ control: ControlRequest; at: number }> = [];
  private pendingPresign: {
    hashes: Set<string>;
    resolve: (urls: PresignedUpload[]) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private expectRedundancyEcho = 0;
  private readonly backoff = new Backoff();
  private readonly sessionUrl: string;
  private readonly handlers: ObserverHandlers;
  private readonly random: () => number;

  constructor(sessionUrl: string, handlers: ObserverHandlers, random: () => number = Math.random) {
    this.sessionUrl = sessionUrl;
    this.handlers = handlers;
    this.random = random;
  }

  get cluster(): ClusterState {
    return this.state;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.outbox = [];
    this.held = [];
    this.socket?.close(1000, "stop");
    this.socket = null;
  }

  /**
   * Queue a control for the control plane. Between subscribes it is held for the next live socket
   * (`CONTROL_HOLD_MS`); returns false only when the client is stopped or the machine is off, in
   * which case nothing is queued: a control issued against a dead machine should not fire later.
   */
  send(control: ControlRequest): boolean {
    if (this.stopped || this.off) return false;
    if (control.t === "setRedundancy") {
      // This page knows the value it asked for; the echo needs no refresh.
      this.expectRedundancyEcho += 1;
      this.state = withRedundancy(this.state, control.on);
      this.handlers.onCluster(this.state);
    }
    if (!this.connected) {
      this.held.push({ control, at: Date.now() });
      return true;
    }
    this.outbox.push(control);
    this.drain();
    return true;
  }

  /** Controls held across a reconnect go out once the new socket is live, if still fresh. */
  private releaseHeld(): void {
    const now = Date.now();
    const fresh = this.held.filter((h) => now - h.at <= CONTROL_HOLD_MS);
    this.held = [];
    for (const h of fresh) this.outbox.push(h.control);
    if (fresh.length > 0) this.drain();
  }

  /**
   * Ask the control plane for presigned upload URLs over this socket (design D18): bundle uploads
   * from the page have no HTTP API. One request at a time; a close or a silent control plane
   * rejects it, so an upload never hangs.
   */
  presign(items: PresignItem[]): Promise<PresignedUpload[]> {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error("not connected"));
      if (this.pendingPresign) return reject(new Error("an upload is already in progress"));
      const timer = setTimeout(() => {
        this.pendingPresign = null;
        reject(new Error("the control plane did not answer the presign"));
      }, PRESIGN_TIMEOUT_MS);
      this.pendingPresign = { hashes: new Set(items.map((i) => i.hash)), resolve, reject, timer };
      this.outbox.push({ t: "presign", items });
      this.drain();
    });
  }

  private settlePresign(urls: PresignedUpload[] | null, error?: string): void {
    const p = this.pendingPresign;
    if (!p) return;
    if (urls && !urls.every((u) => p.hashes.has(u.hash))) return; // not ours
    clearTimeout(p.timer);
    this.pendingPresign = null;
    if (urls) p.resolve(urls);
    else p.reject(new Error(error ?? "presign failed"));
  }

  private drain(): void {
    if (this.sendTimer || this.outbox.length === 0) return;
    const wait = this.lastSentAt + CONTROL_SPACING_MS - Date.now();
    if (wait > 0) {
      this.sendTimer = setTimeout(() => {
        this.sendTimer = null;
        this.drain();
      }, wait);
      return;
    }
    const control = this.outbox.shift() as Outgoing;
    const session = this.session;
    if (!this.connected || !session) {
      // The socket went between the click and the send: controls wait for the next subscribe,
      // a presign does not (its upload would have to start over anyway).
      const now = Date.now();
      for (const o of [control, ...this.outbox]) {
        if (o.t !== "presign") this.held.push({ control: o, at: now });
      }
      this.outbox = [];
      this.settlePresign(null, "not connected");
      return;
    }
    const msg: ObserverToControlPlane = {
      ...control,
      v: PROTOCOL_VERSION,
      gen: session.generation,
    };
    this.socket?.send(encode(msg));
    this.lastSentAt = Date.now();
    this.drain();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    if (!this.resubscribing) this.handlers.onState("connecting");
    let session: Session;
    try {
      session = await fetchSession(this.sessionUrl, (url) => fetch(url, { cache: "no-store" }));
    } catch {
      return this.later(this.backoff.next());
    }
    if (this.stopped) return;
    if (session.kind === "off") {
      this.off = true;
      this.held = [];
      return this.handlers.onState("off");
    }
    this.off = false;
    if (session.kind === "starting") {
      this.handlers.onState("starting");
      return this.later(session.retryAfterMs);
    }
    this.session = session;
    this.handlers.onSession(session);
    const ws = new WebSocket(
      `${session.endpoint.replace(/\/$/, "")}/observer`,
      socketProtocols(session.token),
    );
    this.socket = ws;
    ws.onopen = () => {
      // A reconnect names the last sequence seen; the control plane may replay from there one day
      // and answers with a snapshot until then.
      const since = this.state.seq;
      ws.send(
        encode({
          t: "subscribe",
          v: PROTOCOL_VERSION,
          gen: session.generation,
          ...(since > 0 && session.generation === this.state.generation ? { since } : {}),
        }),
      );
      this.lastSentAt = Date.now();
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(encode({ t: "ping", v: PROTOCOL_VERSION, gen: session.generation }));
      }, LIMITS.observerPingMs);
    };
    ws.onmessage = (ev) => this.onMessage(ws, session, ev.data);
    ws.onclose = (ev) => this.onClose(ws, ev.code, ev.reason);
  }

  private onMessage(ws: WebSocket, session: Session & { kind: "on" }, data: unknown): void {
    const d = decode(controlPlaneToObserver, data, { expectGen: session.generation });
    if (!d.ok) {
      ws.close(d.closeCode, d.reason.slice(0, 120));
      return;
    }
    const msg = d.msg as ControlPlaneToObserver;
    if (msg.t === "presigned") this.settlePresign(msg.urls);
    if (msg.t === "controlApplied" && msg.op === "setRedundancy" && this.expectRedundancyEcho > 0) {
      this.expectRedundancyEcho -= 1;
      this.state = { ...applyMessage(this.state, msg), refresh: false };
    } else {
      this.state = applyMessage(this.state, msg);
    }
    if (this.state.gap) {
      // Missed an event: the snapshot is the only honest recovery. The control plane refuses a
      // second subscribe on one socket, so the reconnect is immediate and silent.
      this.state = { ...this.state, gap: false };
      this.resubscribe(ws, 0);
      return;
    }
    if (this.state.refresh) {
      // Someone else changed the machine; only a snapshot carries the new value. Spread the
      // refresh so a room full of observers does not hit the session function at once.
      this.state = { ...this.state, refresh: false };
      this.resubscribe(ws, this.random() * REFRESH_JITTER_MS);
    }
    if (msg.t === "snapshot" && this.state.pagesPending === 0) {
      this.resubscribing = false;
      this.handlers.onState("live");
      this.releaseHeld();
    }
    this.handlers.onCluster(this.state);
  }

  private resubscribe(ws: WebSocket, delayMs: number): void {
    if (this.resubscribing) return;
    this.resubscribing = true;
    this.clearTimers();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      ws.onclose = null;
      ws.close(1000, "resubscribe");
      if (this.socket === ws) this.socket = null;
      void this.connect();
    }, delayMs);
  }

  private onClose(ws: WebSocket, code: number, reason: string): void {
    if (this.socket !== ws) return;
    this.clearTimers();
    this.socket = null;
    this.outbox = [];
    this.settlePresign(null, "the socket closed");
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
    } else {
      this.resubscribing = false;
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
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.sendTimer = null;
  }
}
