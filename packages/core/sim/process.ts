// The process around the core as the simulation runs it — the mirror of packages/control-plane's
// server.ts. It carries frames both ways over sockets with latency, answers fetchBlob, putBlob,
// and presign against the fake store, hands launchCore and terminateCore to the fake fleet, and
// feeds every event through the harness, hashing the event and its effects into the trace.
import { createHash } from "node:crypto";
import {
  decodeStageSpec,
  encode,
  encodeStageSpec,
  PROTOCOL_VERSION,
  type StageSpec,
} from "@tabframe/protocol";
import type { Effect, Event } from "../src/events.ts";
import { beginHandover, drain } from "../src/handover.ts";
import type { Harness } from "../src/harness.ts";
import type { ConnRole, FetchPurpose, Ledger } from "../src/ledger.ts";
import type { Timeline } from "./clock.ts";
import type { FakeStore } from "./store.ts";
import { type Client, count, type Realism, type SimStats, type Socket } from "./types.ts";
import { closeName, describeEffect, describeEvent } from "./wire.ts";

/** What the process needs from the world around it. */
export interface ProcessHost {
  readonly timeline: Timeline;
  readonly store: FakeStore;
  readonly stats: SimStats;
  readonly realism: Realism;
  readonly gen: number;
  /** The outermost tiles every stage is trimmed to; null renders whole frames. */
  readonly tiles: number | null;
  random(): number;
  between(min: number, max: number): number;
  violation(text: string): void;
  note(text: string): void;
  fleet(): { launch(): void; terminate(microvmId: string): void };
  /** Every event with its effects, before the effects run. */
  observe(event: Event, effects: Effect[]): void;
  /** After the effects ran. */
  settled(): void;
  /** A rotation moved the machine to a new generation. */
  rotated(next: number): void;
}

export class Process {
  private readonly host: ProcessHost;
  private readonly h: Harness;
  private readonly sockets = new Map<string, Socket>();
  private connCounter = 0;
  /** Task index → golden index for the stages the sim trimmed to a subset. */
  private readonly subsets = new Map<string, number[]>();
  private readonly trace = createHash("sha256");

  constructor(host: ProcessHost, h: Harness) {
    this.host = host;
    this.h = h;
  }

  /** The control plane's ledger; a rotation swaps it under the same process. */
  get ledger(): Ledger {
    return this.h.ledger;
  }

  /** Hash of every event and its effects: two runs with the same inputs produce the same trace. */
  traceDigest(): string {
    return this.trace.digest("hex");
  }

  /** The golden indices a trimmed stage kept, if it was trimmed. */
  subsetFor(executionId: string, stage: number): number[] | undefined {
    return this.subsets.get(`${executionId}:${stage}`);
  }

  // --- the transport, client side ---

  connect(client: Client, role: ConnRole): Socket {
    const connId = `c${++this.connCounter}`;
    const sock: Socket = {
      connId,
      role,
      client,
      clientOpen: true,
      cpOpen: true,
      toCpAt: this.host.timeline.now,
      toClientAt: this.host.timeline.now,
    };
    this.sockets.set(connId, sock);
    this.host.timeline.at(this.arrival(sock, "toCp"), () => {
      if (sock.cpOpen) this.dispatch({ kind: "connected", connId, role });
    });
    return sock;
  }

  send(sock: Socket, msg: Record<string, unknown>): void {
    if (!sock.clientOpen) return;
    const raw = JSON.stringify({ ...msg, v: PROTOCOL_VERSION, gen: this.host.gen });
    this.host.stats.messagesToControlPlane += 1;
    const deliveries =
      this.host.realism.duplicateRate > 0 && this.host.random() < this.host.realism.duplicateRate
        ? 2
        : 1;
    for (let i = 0; i < deliveries; i++) {
      this.host.timeline.at(this.arrival(sock, "toCp"), () => {
        if (sock.cpOpen) this.dispatch({ kind: "message", connId: sock.connId, raw });
      });
    }
  }

  close(sock: Socket): void {
    if (!sock.clientOpen) return;
    sock.clientOpen = false;
    this.host.timeline.at(this.arrival(sock, "toCp"), () => {
      if (!sock.cpOpen) return;
      sock.cpOpen = false;
      this.dispatch({ kind: "disconnected", connId: sock.connId });
    });
  }

  crash(sock: Socket): void {
    sock.clientOpen = false;
  }

  private netLatency(): number {
    return this.host.between(5, 80);
  }

  private storeLatency(): number {
    return this.host.between(10, 60);
  }

  /** FIFO per direction: the next message arrives after the previous one, plus its own latency. */
  private arrival(sock: Socket, dir: "toCp" | "toClient"): number {
    const key = dir === "toCp" ? "toCpAt" : "toClientAt";
    const at = Math.max(this.host.timeline.now + this.netLatency(), sock[key]);
    sock[key] = at;
    return at;
  }

  // --- the core and its effects ---

  dispatch(event: Event): void {
    this.h.advance(this.host.timeline.now - this.h.now);
    let effects: Effect[];
    try {
      effects = this.h.event(event);
    } catch (err) {
      const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
      this.host.violation(`apply threw on ${describeEvent(event)}: ${text}`);
      return;
    }
    this.host.stats.events += 1;
    const line = `${describeEvent(event)} → ${effects.map(describeEffect).join(", ") || "nothing"}`;
    this.trace.update(`${this.host.timeline.now} ${line}\n`);
    this.host.note(`[seq ${this.ledger.meta.seq}] ${line}`);
    this.host.observe(event, effects);
    this.execute(effects);
    this.host.settled();
  }

  /**
   * A rotation in place (design §9.4): the ledger is handed over, every client is drained with its
   * reconnect delay, and the successor adopts under the same process and a new generation.
   */
  rotate(next: number): void {
    const now = this.host.timeline.now;
    const { json } = beginHandover(this.ledger, now);
    const closes = drain(this.ledger, next, () => this.host.random());
    this.trace.update(`${now} rotate → generation ${next}\n`);
    this.host.note(`rotating to generation ${next}`);
    this.execute(closes);
    const effects = this.h.adopt(json, next);
    this.host.rotated(next);
    this.execute(effects);
  }

  private execute(effects: Effect[]): void {
    // A send is checked against the ledger unless the same batch closes that connection later:
    // a sweep may announce one departure to an observer it declares gone a moment after.
    const closing = new Set<string>();
    for (const e of effects) if (e.kind === "close") closing.add(e.connId);
    for (const e of effects) {
      switch (e.kind) {
        case "send":
          this.deliver(e.connId, e.msg, !closing.has(e.connId));
          break;
        case "close": {
          const sock = this.sockets.get(e.connId);
          count(this.host.stats.closes, closeName(e.code));
          if (!sock) {
            this.host.violation(`close of unknown connection ${e.connId}`);
            break;
          }
          if (!sock.cpOpen) break;
          sock.cpOpen = false;
          this.host.timeline.at(this.arrival(sock, "toClient"), () => {
            if (!sock.clientOpen) return;
            sock.clientOpen = false;
            sock.client.onClosed(e.code, e.reason);
          });
          break;
        }
        case "fetchBlob": {
          const { hash, purpose } = e;
          const rate = this.host.realism.storeFailRate;
          const fails = rate > 0 && this.host.random() < rate;
          this.host.timeline.after(this.storeLatency(), () => {
            if (fails) {
              this.dispatch({
                kind: "blobFetched",
                hash,
                bytes: null,
                purpose,
                error: "the simulated store failed",
              });
              return;
            }
            let bytes = this.host.store.get(hash);
            if (bytes && purpose.type === "stageSpec") bytes = this.rewriteSpec(bytes, purpose);
            this.dispatch({ kind: "blobFetched", hash, bytes, purpose });
          });
          break;
        }
        case "putBlob": {
          const { bytes, purpose } = e;
          this.host.timeline.after(this.storeLatency(), () => {
            const hash = this.host.store.put(bytes);
            this.dispatch({ kind: "blobStored", hash, size: bytes.length, purpose });
          });
          break;
        }
        case "resolveBundle": {
          // Every launch in the simulation names the seeded bundle, so the ledger knows it.
          this.host.violation(`resolveBundle for ${e.bundle.slice(0, 12)} asked by ${e.connId}`);
          const { bundle, connId } = e;
          this.host.timeline.after(this.storeLatency(), () =>
            this.dispatch({ kind: "bundleRejected", bundle, connId, reason: "unknown bundle" }),
          );
          break;
        }
        case "launchCore":
          this.host.fleet().launch();
          break;
        case "terminateCore":
          this.host.fleet().terminate(e.microvmId);
          break;
        case "presign": {
          const { connId, items } = e;
          this.host.timeline.after(this.storeLatency(), () => {
            const urls = items.map(({ hash }) => ({
              hash,
              url: this.host.store.has(hash) ? null : `https://store.sim/put/${hash}`,
              headers: { "x-amz-checksum-sha256": hash },
            }));
            this.deliver(
              connId,
              { t: "presigned", v: PROTOCOL_VERSION, gen: this.host.gen, urls },
              false,
            );
          });
          break;
        }
      }
    }
  }

  private deliver(
    connId: string,
    msg: { t: string; [key: string]: unknown },
    fromApply: boolean,
  ): void {
    const sock = this.sockets.get(connId);
    if (!sock) {
      this.host.violation(`send ${msg.t} to unknown connection ${connId}`);
      return;
    }
    if (fromApply && !this.ledger.conns.has(connId))
      this.host.violation(`send ${msg.t} to forgotten connection ${connId}`);
    if (!sock.cpOpen) return;
    let raw: string;
    try {
      raw = encode(msg);
    } catch (err) {
      this.host.violation(
        `${msg.t} to ${connId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    this.host.stats.messagesToClients += 1;
    this.host.timeline.at(this.arrival(sock, "toClient"), () => {
      if (sock.clientOpen) sock.client.receive(raw);
    });
  }

  /**
   * The store hands the planner's spec back to the core; the sim may trim it to the outermost
   * tiles (`tiles`) and pins a `done` follow-up to this frame's params, so every frame is one the
   * goldens cover and the compute cache already holds.
   */
  private rewriteSpec(bytes: Uint8Array, purpose: FetchPurpose): Uint8Array {
    if (purpose.type !== "stageSpec") return bytes;
    let spec: StageSpec;
    try {
      spec = decodeStageSpec(bytes);
    } catch {
      return bytes;
    }
    const stage = this.ledger.tasks.get(purpose.taskId)?.stage ?? 0;
    if (spec.kind === "stage") {
      const n = this.host.tiles;
      if (n === null || n >= spec.tasks.length) return bytes;
      const first = spec.tasks.length - n;
      const kept = spec.tasks.slice(first);
      this.subsets.set(
        `${purpose.executionId}:${stage}`,
        kept.map((_, i) => first + i),
      );
      return encodeStageSpec({ ...spec, tasks: kept });
    }
    if (!spec.next) return bytes;
    const exec = this.ledger.executions.get(purpose.executionId);
    const preset = exec?.params.preset;
    return encodeStageSpec({
      kind: "done",
      next: { ...spec.next, preset: typeof preset === "number" ? preset : 0 },
    });
  }
}
