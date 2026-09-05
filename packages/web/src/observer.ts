// The observer socket: session → subscribe → snapshot and events, pinging every two seconds,
// reconnecting for a fresh snapshot on a sequence gap, and reconnecting through a fresh session
// after any close. Controls go out spaced under the observer rate limit.
import { Backoff } from "@tabframe/node/backoff";
import { fetchSession, type Session, socketProtocols } from "@tabframe/node/session";
import {
  CLOSE,
  type ControlPlaneToObserver,
  controlPlaneToObserver,
  decode,
  encode,
  LIMITS,
  type ObserverToControlPlane,
  PROTOCOL_VERSION,
} from "@tabframe/protocol";
import type { PresignedUpload, PresignItem } from "@tabframe/store";
import { applyMessage, type ClusterState, emptyState, withRedundancy } from "./cluster-state.ts";
import type { ControlRequest } from "./controls.ts";

export type MachineState = "connecting" | "starting" | "off" | "live" | "outdated" | "full";

export interface ObserverHandlers {
  /** Controls held across a reconnect that were too old to send. */
  onDropped?: (count: number) => void;
  onState(machine: MachineState, detail?: string): void;
  onCluster(state: ClusterState): void;
  onSession(session: Session & { kind: "on" }): void;
}

/** The part of a `WebSocket` the client uses; a test passes a fake. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
}

/** What the client reaches the world through; every default is the browser's. */
export interface ObserverDeps {
  random?: () => number;
  now?: () => number;
  fetch?: (
    url: string,
    init?: { cache: RequestCache },
  ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  socket?: (url: string, protocols?: string[]) => WebSocketLike;
}

/** Anything the page sends besides subscribe and ping, before the version and generation are stamped. */
type Outgoing = ControlRequest | { t: "presign"; items: PresignItem[] };

/** `WebSocket.OPEN`. */
const OPEN = 1;

/** How long a presign may stay unanswered before the upload gives up. */
export const PRESIGN_TIMEOUT_MS = 30_000;

/** Spacing between outgoing controls: with a ping every two seconds this stays under the observer rate. */
export const CONTROL_SPACING_MS = Math.ceil(1000 / (LIMITS.observerMessagesPerSecond - 1));

/**
 * A control issued while the socket is between subscribes — a silent resubscribe after a
 * sequence gap or a refresh, or the seconds of a rotation — is held for the next live socket this
 * long, then dropped: the machine a person clicked at a moment ago is the one they meant, a
 * machine that has been gone for longer is not.
 */
export const CONTROL_HOLD_MS = 10_000;
/** How long a page waits before asking a full machine again. */
export const MACHINE_FULL_RETRY_MS = 10_000;
/** How often a page facing an off machine asks the session again; the banner promises it. */
export const OFF_POLL_MS = 15_000;
/** A quiet refresh spreads the reconnects of many observers over this many milliseconds. */
export const REFRESH_JITTER_MS = 4_000;

export class ObserverClient {
  private socket: WebSocketLike | null = null;
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
  private readonly now: () => number;
  private readonly fetch: NonNullable<ObserverDeps["fetch"]>;
  private readonly connectSocket: NonNullable<ObserverDeps["socket"]>;

  constructor(sessionUrl: string, handlers: ObserverHandlers, deps: ObserverDeps = {}) {
    this.sessionUrl = sessionUrl;
    this.handlers = handlers;
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.fetch = deps.fetch ?? ((url, init) => fetch(url, init));
    this.connectSocket = deps.socket ?? ((url, protocols) => new WebSocket(url, protocols));
  }

  get cluster(): ClusterState {
    return this.state;
  }

  get connected(): boolean {
    return this.socket?.readyState === OPEN;
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
    return this.sendStatus(control) !== "refused";
  }

  /** Like `send`, but says whether the control went out now or waits for the next socket. */
  sendStatus(control: ControlRequest): "sent" | "held" | "refused" {
    if (this.stopped || this.off) return "refused";
    this.anticipate(control);
    if (!this.connected) {
      this.held.push({ control, at: this.now() });
      return "held";
    }
    this.outbox.push(control);
    this.drain();
    return "sent";
  }

  /** This page knows the redundancy value it asked for: show it now, and expect the echo. */
  private anticipate(control: ControlRequest): void {
    if (control.t !== "setRedundancy") return;
    this.expectRedundancyEcho += 1;
    this.state = withRedundancy(this.state, control.on);
    this.handlers.onCluster(this.state);
  }

  /**
   * Controls held across a reconnect go out once the new socket is live, if still fresh. The
   * snapshot that made the socket live carried the machine's old redundancy value, so a held
   * toggle is anticipated again (the echo count was already taken at the click).
   */
  private releaseHeld(): void {
    const now = this.now();
    const fresh = this.held.filter((h) => now - h.at <= CONTROL_HOLD_MS);
    const dropped = this.held.length - fresh.length;
    this.held = [];
    // A click that waited longer than the hold is dropped, and said so (rule R2).
    if (dropped > 0) this.handlers.onDropped?.(dropped);
    for (const h of fresh) {
      if (h.control.t === "setRedundancy") {
        this.state = withRedundancy(this.state, h.control.on);
        this.handlers.onCluster(this.state);
      }
      this.outbox.push(h.control);
    }
    // A control that waited behind the spacing timer when the socket was swapped sits in the
    // outbox, not in `held`: drain that too.
    this.drain();
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
    const wait = this.lastSentAt + CONTROL_SPACING_MS - this.now();
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
      const now = this.now();
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
    this.lastSentAt = this.now();
    this.drain();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    if (!this.resubscribing) this.handlers.onState("connecting");
    let session: Session;
    try {
      session = await fetchSession(this.sessionUrl, (url) =>
        this.fetch(url, { cache: "no-store" }),
      );
    } catch {
      // A session that cannot be fetched ends a silent resubscribe: the page must show
      // "connecting", not a live pill over stale numbers.
      if (this.resubscribing) {
        this.resubscribing = false;
        this.handlers.onState("connecting");
      }
      return this.later(this.backoff.next());
    }
    if (this.stopped) return;
    if (session.kind === "off") {
      this.off = true;
      this.held = [];
      this.handlers.onState("off");
      return this.later(OFF_POLL_MS);
    }
    this.off = false;
    if (session.kind === "starting") {
      this.handlers.onState("starting");
      return this.later(session.retryAfterMs);
    }
    this.session = session;
    this.handlers.onSession(session);
    const ws = this.connectSocket(
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
      this.lastSentAt = this.now();
      this.pingTimer = setInterval(() => {
        if (ws.readyState === OPEN)
          ws.send(encode({ t: "ping", v: PROTOCOL_VERSION, gen: session.generation }));
      }, LIMITS.observerPingMs);
    };
    ws.onmessage = (ev) => this.onMessage(ws, session, ev.data);
    ws.onclose = (ev) => this.onClose(ws, ev.code, ev.reason);
  }

  private onMessage(ws: WebSocketLike, session: Session & { kind: "on" }, data: unknown): void {
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
      // A healthy session resets the reconnect backoff, or every hourly rotation would count
      // against a dashboard open all day.
      this.backoff.reset();
      this.handlers.onState("live");
      this.releaseHeld();
    }
    this.handlers.onCluster(this.state);
  }

  /** Controls still in the outbox wait for the next live socket instead of vanishing. */
  private holdOutbox(): void {
    const now = this.now();
    for (const o of this.outbox) if (o.t !== "presign") this.held.push({ control: o, at: now });
    this.outbox = [];
  }

  private resubscribe(ws: WebSocketLike, delayMs: number): void {
    if (this.resubscribing) return;
    this.resubscribing = true;
    this.clearTimers();
    this.holdOutbox();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      ws.onclose = null;
      ws.close(1000, "resubscribe");
      if (this.socket === ws) this.socket = null;
      void this.connect();
    }, delayMs);
  }

  private onClose(ws: WebSocketLike, code: number, reason: string): void {
    if (this.socket !== ws) return;
    this.clearTimers();
    this.socket = null;
    this.holdOutbox();
    this.settlePresign(null, "the socket closed");
    if (this.stopped) return;
    if (code === CLOSE.versionMismatch) {
      this.handlers.onState("outdated", reason);
      return;
    }
    let delay: number | null = null;
    if (code === CLOSE.machineFull) {
      // Every client seat is taken: say so, and try again when the server suggested.
      this.handlers.onState("full", reason);
      delay = MACHINE_FULL_RETRY_MS;
    }
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
    this.later(delay ?? this.backoff.next());
  }

  /** The delay the last reconnect chose; tests read it. */
  lastDelayMs = 0;

  private later(ms: number): void {
    this.lastDelayMs = ms;
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
