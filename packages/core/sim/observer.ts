// A virtual observer: a dashboard reduced to what it checks. It subscribes, pings, sends the
// controls the chaos generator asks for, and validates the stream the way a dashboard depends on
// it: every message decodes against the wire schema, page 0 of a snapshot carries the cluster,
// sequence numbers are consecutive, and a stage it watched from the start reports every task done
// before the stage is declared done.
import {
  CLOSE,
  type ControlPlaneToObserver,
  controlPlaneToObserver,
  decode,
  LIMITS,
  type Snapshot,
} from "@tabframe/protocol";
import { type Client, count, type Socket, type Timer, type WorldApi } from "./types.ts";
import { closeName } from "./wire.ts";

const FATAL_CLOSES = new Set<number>([
  CLOSE.invalidMessage,
  CLOSE.versionMismatch,
  CLOSE.rateLimited,
  CLOSE.generationMismatch,
]);

interface StageWatch {
  executionId: string;
  stage: number;
  taskCount: number;
  done: Set<string>;
  /** True when this observer saw the stage start, so its count is complete. */
  complete: boolean;
}

export class VirtualObserver implements Client {
  readonly id: string;
  sock: Socket | null = null;
  subscribed = false;
  lastSeq = -1;
  lastLaunchAt = Number.NEGATIVE_INFINITY;
  lastCancelAt = Number.NEGATIVE_INFINITY;
  events = 0;
  private readonly world: WorldApi;
  private pingTimer: Timer | null = null;
  private lastControlAt = Number.NEGATIVE_INFINITY;
  private watch: StageWatch | null = null;

  constructor(world: WorldApi, id: string) {
    this.world = world;
    this.id = id;
  }

  get connected(): boolean {
    return this.sock !== null;
  }

  join(): void {
    if (this.sock) return;
    this.sock = this.world.connect(this, "observer");
    this.world.send(this.sock, { t: "subscribe" });
    this.world.stats.observerJoins += 1;
    this.world.note(`${this.id} subscribes`);
  }

  leave(): void {
    if (!this.sock) return;
    this.world.close(this.sock);
    this.drop();
    this.world.stats.observerLeaves += 1;
    this.world.note(`${this.id} leaves`);
  }

  crash(): void {
    if (!this.sock) return;
    this.world.crash(this.sock);
    this.drop();
    this.world.stats.observerLeaves += 1;
    this.world.note(`${this.id} crashes`);
  }

  /** Send a control if the observer is subscribed and its one-per-second budget allows. */
  control(msg: Record<string, unknown>): boolean {
    if (!this.sock || !this.subscribed) return false;
    if (this.world.now - this.lastControlAt < 1_000) return false;
    this.lastControlAt = this.world.now;
    this.world.send(this.sock, msg);
    count(this.world.stats.controls, String(msg.t));
    this.world.note(`${this.id} sends ${String(msg.t)}`);
    return true;
  }

  receive(raw: string): void {
    const d = decode(controlPlaneToObserver, raw, { expectGen: this.world.gen });
    if (!d.ok) {
      this.world.violation(`observer ${this.id}: undecodable message: ${d.reason}`);
      return;
    }
    const msg = d.msg;
    switch (msg.t) {
      case "snapshot":
        this.onSnapshot(msg);
        return;
      case "pong":
        if (msg.seq < this.lastSeq)
          this.world.violation(`observer ${this.id}: pong seq ${msg.seq} behind ${this.lastSeq}`);
        return;
      case "error":
        count(this.world.stats.controls, `error:${msg.code}`);
        return;
      case "presigned":
        return;
      default:
        this.onEvent(msg);
    }
  }

  onClosed(code: number, reason: string): void {
    if (FATAL_CLOSES.has(code))
      this.world.violation(`observer ${this.id} closed: ${closeName(code)} (${reason})`);
    this.drop();
  }

  private onSnapshot(msg: Snapshot): void {
    if (msg.page >= msg.pages)
      this.world.violation(`observer ${this.id}: snapshot page ${msg.page} of ${msg.pages}`);
    if (msg.page === 0) {
      if (!msg.nodes || !msg.queue || !msg.machine || !msg.programs || msg.execution === undefined)
        this.world.violation(`observer ${this.id}: snapshot page 0 lacks the cluster`);
      this.subscribed = true;
      this.lastSeq = msg.seq;
      // A stage already under way is watched incompletely: its count is not checked.
      this.watch = msg.execution
        ? {
            executionId: msg.execution.executionId,
            stage: msg.execution.stage,
            taskCount: msg.execution.taskCount,
            done: new Set(),
            complete: false,
          }
        : null;
      this.schedulePing();
    } else if (msg.seq !== this.lastSeq) {
      this.world.violation(
        `observer ${this.id}: snapshot pages carry seqs ${this.lastSeq}/${msg.seq}`,
      );
    }
  }

  private onEvent(
    msg: Exclude<ControlPlaneToObserver, { t: "snapshot" | "pong" | "error" | "presigned" }>,
  ): void {
    this.events += 1;
    if (msg.seq !== this.lastSeq + 1)
      this.world.violation(`observer ${this.id}: seq ${this.lastSeq} → ${msg.seq} on ${msg.t}`);
    this.lastSeq = msg.seq;
    switch (msg.t) {
      case "executionStarted":
        this.watch = {
          executionId: msg.execution.executionId,
          stage: -1,
          taskCount: 0,
          done: new Set(),
          complete: true,
        };
        return;
      case "stageStarted":
        if (this.watch?.executionId === msg.executionId) {
          this.watch.stage = msg.stage;
          this.watch.taskCount = msg.taskCount;
          this.watch.done = new Set();
          this.watch.complete = true;
        }
        return;
      case "taskDone":
        this.watch?.done.add(msg.taskId);
        return;
      case "stageDone":
        if (
          this.watch?.complete &&
          this.watch.executionId === msg.executionId &&
          this.watch.stage === msg.stage &&
          this.watch.done.size !== this.watch.taskCount
        ) {
          this.world.violation(
            `observer ${this.id}: stage ${msg.stage} of ${msg.executionId} done after ${this.watch.done.size} of ${this.watch.taskCount} taskDone events`,
          );
        }
        return;
      case "executionDone":
      case "executionFailed":
        if (this.watch?.executionId === msg.executionId) this.watch = null;
        return;
      default:
        return;
    }
  }

  private schedulePing(): void {
    this.pingTimer = this.world.after(LIMITS.observerPingMs, () => {
      this.pingTimer = null;
      if (!this.sock) return;
      this.world.send(this.sock, { t: "ping" });
      this.schedulePing();
    });
  }

  private drop(): void {
    this.sock = null;
    this.subscribed = false;
    this.watch = null;
    if (this.pingTimer) {
      this.world.cancel(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
