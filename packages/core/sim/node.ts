// A virtual node: the orchestrator of design §4 reduced to what the control plane can observe.
// It speaks the node wire exactly (hello, heartbeat, presign, result), runs real tasks through the
// sandbox against the fake store, and takes virtual time to do so: its compute time is drawn from
// the seed, never measured, so a run replays exactly on any machine. Its modes are the failures
// the design names: clean leave, silent crash, freeze (no heartbeat, no compute), hidden tab, slow
// hardware, the four commands, and a liar that returns consistent wrong bytes. With
// `deadlineEnforced` it also gives a task back at its deadline, as the real orchestrator does.
import {
  type Assign,
  byteLength,
  CLOSE,
  controlPlaneToNode,
  decode,
  encodeRunInput,
  type FsManifest,
  fsManifest,
  LIMITS,
  RELEASED,
} from "@tabframe/protocol";
import { CachingBlobReader } from "@tabframe/sandbox";
import { fromBase64 } from "../src/bytes.ts";
import { compute } from "./program.ts";
import { sha256 } from "./store.ts";
import type { Client, Socket, Timer, WorldApi } from "./types.ts";
import { closeName } from "./wire.ts";

export interface NodeProfile {
  hostId: string;
  /** The launch token a cloud core shows in its hello (WP8.3). */
  coreToken?: string;
  kind: "tab" | "core";
  /** Compute-time multiplier: 1 is the reference machine, 3 is a slow one. */
  speed: number;
  liar: boolean;
  /** A cloud core the control plane launched: the fleet owns its life, not the chaos generator. */
  fleet?: boolean;
}

interface Blob {
  hash: string;
  bytes: Uint8Array;
}

interface Work {
  msg: Assign;
  assignedAt: number;
  /** Virtual milliseconds of compute left at the current speed. */
  remainingMs: number;
  startedAt: number;
  timer: Timer | null;
  /** With `deadlineEnforced`, the moment the node gives the task back. */
  deadline: Timer | null;
  phase: "computing" | "uploading";
  /** Hashes still to upload before the result can go out. */
  awaiting: Set<string>;
  blobs: Map<string, Blob>;
  result: Record<string, unknown> | null;
}

/** Closes a well-behaved client must never receive. */
const FATAL_CLOSES = new Set<number>([
  CLOSE.invalidMessage,
  CLOSE.versionMismatch,
  CLOSE.rateLimited,
  CLOSE.generationMismatch,
]);

const EMPTY_MANIFEST: FsManifest = { version: 1, files: {} };

export class VirtualNode implements Client {
  readonly id: string;
  readonly profile: NodeProfile;
  sock: Socket | null = null;
  nodeId: string | null = null;
  /** Self-inflicted states (a hung tab, a hidden tab). */
  frozen = false;
  hidden = false;
  /** What the control plane commanded. */
  commanded: "freeze" | "throttle" | null = null;
  /** Reconnect after a control-plane close, the way the real orchestrator does. */
  autoRejoin = true;
  retired = false;
  tasksDone = 0;
  lastTaskMs: number | null = null;
  private readonly world: WorldApi;
  private heartbeatMs: number = LIMITS.heartbeatMs;
  private heartbeatTimer: Timer | null = null;
  private rejoinTimer: Timer | null = null;
  private readonly work = new Map<string, Work>();
  private readonly uploaded = new Set<string>();
  private readonly reader: CachingBlobReader;
  private readonly manifests = new Map<string, FsManifest>();

  constructor(world: WorldApi, id: string, profile: NodeProfile) {
    this.world = world;
    this.id = id;
    this.profile = profile;
    this.reader = new CachingBlobReader(world.store);
  }

  get connected(): boolean {
    return this.sock !== null;
  }

  get joined(): boolean {
    return this.nodeId !== null;
  }

  get paused(): boolean {
    return this.frozen || this.commanded === "freeze";
  }

  get inFlight(): number {
    return this.work.size;
  }

  describe(): string {
    return this.nodeId ? `${this.id}/${this.nodeId}` : this.id;
  }

  /** A one-line dump for stall reports: the modes and what each held task is waiting on. */
  state(): string {
    const flags = [
      this.connected ? "connected" : "disconnected",
      this.frozen ? "frozen" : null,
      this.commanded ? `commanded-${this.commanded}` : null,
      this.hidden ? "hidden" : null,
      this.retired ? "retired" : null,
      `speed ${this.profile.speed}`,
    ].filter((f) => f !== null);
    const work = [...this.work.values()].map(
      (w) =>
        `${w.msg.taskId}:${w.phase}${w.timer ? "" : " no-timer"}${w.awaiting.size > 0 ? ` awaiting ${w.awaiting.size}` : ""}`,
    );
    return `${flags.join(" ")}${work.length > 0 ? ` | ${work.join(" ")}` : " | idle"}`;
  }

  // --- lifecycle driven by the chaos generator ---

  join(): void {
    if (this.retired || this.sock) return;
    if (this.rejoinTimer) {
      this.world.cancel(this.rejoinTimer);
      this.rejoinTimer = null;
    }
    this.sock = this.world.connect(this, "node");
    this.world.send(this.sock, {
      t: "hello",
      hostId: this.profile.hostId,
      ...(this.profile.coreToken ? { coreToken: this.profile.coreToken } : {}),
      kind: this.profile.kind,
      cores: 4,
      sandboxVersion: "sim",
    });
    this.world.stats.joins += 1;
    this.world.note(`${this.id} joins${this.profile.liar ? " (liar)" : ""}`);
  }

  /** The chaos generator brings a parked node back. */
  rejoin(): void {
    this.autoRejoin = true;
    this.join();
  }

  /** Close the tab: a clean close the control plane sees as a disconnect. */
  leave(): void {
    if (!this.sock) return;
    this.world.close(this.sock);
    this.dropConnection();
    this.autoRejoin = false;
    this.world.stats.leaves += 1;
    this.world.note(`${this.id} leaves`);
  }

  /** Pull the plug: nothing more is sent, no close either. */
  crash(): void {
    if (!this.sock) return;
    this.world.crash(this.sock);
    this.dropConnection();
    this.autoRejoin = false;
    this.world.stats.crashes += 1;
    this.world.note(`${this.id} crashes`);
  }

  /** A hung tab: the socket stays open, heartbeats and compute stop. */
  freezeSelf(): void {
    if (this.frozen) return;
    this.frozen = true;
    this.pause();
    this.world.stats.freezes += 1;
    this.world.note(`${this.id} freezes`);
  }

  thaw(): void {
    if (!this.frozen) return;
    this.frozen = false;
    if (this.sock) this.unpause();
    else if (this.autoRejoin) this.join();
    this.world.note(`${this.id} thaws`);
  }

  /** A hidden tab: heartbeats say so and the browser throttles compute. */
  hide(): void {
    if (this.hidden || this.profile.kind !== "tab") return;
    const before = this.multiplier();
    this.hidden = true;
    this.retime(before);
    this.world.stats.hides += 1;
  }

  show(): void {
    if (!this.hidden) return;
    const before = this.multiplier();
    this.hidden = false;
    this.retime(before);
    this.unpause();
  }

  /**
   * Its MicroVM was destroyed (design §6.8): the socket dies with no close frame and nothing comes
   * back under this identity. The control plane finds out through silence, and the fleet through
   * the process's reconciler.
   */
  kill(): void {
    this.retired = true;
    this.autoRejoin = false;
    this.frozen = false;
    if (this.rejoinTimer) {
      this.world.cancel(this.rejoinTimer);
      this.rejoinTimer = null;
    }
    if (this.sock) {
      this.world.crash(this.sock);
      this.dropConnection();
    }
    this.world.note(`${this.describe()} microvm destroyed`);
  }

  /** Leave for good. */
  retire(): void {
    this.retired = true;
    this.frozen = false;
    if (this.sock) {
      this.world.close(this.sock);
      this.dropConnection();
    }
  }

  // --- the wire ---

  receive(raw: string): void {
    const d = decode(controlPlaneToNode, raw, { expectGen: this.world.gen });
    if (!d.ok) {
      this.world.violation(
        `node ${this.describe()}: undecodable control-plane message: ${d.reason}`,
      );
      return;
    }
    const msg = d.msg;
    switch (msg.t) {
      case "welcome":
        this.nodeId = msg.nodeId;
        this.heartbeatMs = msg.heartbeatMs;
        if (msg.maxInFlight !== LIMITS.maxInFlight)
          this.world.violation(`welcome carries maxInFlight ${msg.maxInFlight}`);
        this.scheduleHeartbeat();
        return;
      case "assign":
        this.onAssign(msg);
        return;
      case "cancel":
        this.onCancel(msg.taskId);
        return;
      case "command":
        this.onCommand(msg.op);
        return;
      case "presigned":
        this.onPresigned(msg.urls);
        return;
    }
  }

  onClosed(code: number, reason: string): void {
    if (FATAL_CLOSES.has(code))
      this.world.violation(
        `node ${this.describe()} closed by the control plane: ${closeName(code)} (${reason})`,
      );
    this.world.note(`${this.describe()} closed: ${closeName(code)} ${reason}`);
    this.dropConnection();
    if (this.autoRejoin && !this.frozen && !this.retired) {
      const delay = this.world.between(LIMITS.reconnectMinMs, 3_000);
      this.rejoinTimer = this.world.after(delay, () => {
        this.rejoinTimer = null;
        this.join();
      });
    }
  }

  private onAssign(msg: Assign): void {
    const who = this.describe();
    if (this.commanded === "freeze")
      this.world.violation(`${who} assigned ${msg.taskId} after the control plane froze it`);
    if (this.work.has(msg.taskId)) this.world.violation(`${who} assigned ${msg.taskId} twice`);
    if (this.work.size >= LIMITS.maxInFlight)
      this.world.violation(
        `${who} assigned ${msg.taskId} with ${this.work.size} already in flight`,
      );
    if (msg.fsRoot !== null && !this.world.store.has(msg.fsRoot))
      this.world.violation(`${who} assigned ${msg.taskId} with fsRoot the store lacks`);
    const work: Work = {
      msg,
      assignedAt: this.world.now,
      remainingMs: this.duration(msg),
      startedAt: this.world.now,
      timer: null,
      deadline: null,
      phase: "computing",
      awaiting: new Set(),
      blobs: new Map(),
      result: null,
    };
    this.work.set(msg.taskId, work);
    if (this.world.realism.deadlineEnforced)
      work.deadline = this.world.after(msg.deadlineMs, () => this.giveUp(work));
    if (!this.paused) this.startTimer(work);
  }

  /** The deadline passed while still computing: the attempt is released, as the orchestrator does. */
  private giveUp(work: Work): void {
    work.deadline = null;
    const taskId = work.msg.taskId;
    if (this.work.get(taskId) !== work || work.phase !== "computing" || !this.sock || this.paused)
      return;
    if (work.timer) this.world.cancel(work.timer);
    this.work.delete(taskId);
    this.world.send(this.sock, {
      t: "result",
      taskId,
      attempt: work.msg.attempt,
      error: RELEASED,
      computeMs: Math.max(1, this.world.now - work.assignedAt),
    });
  }

  private clearDeadline(work: Work): void {
    if (work.deadline) this.world.cancel(work.deadline);
    work.deadline = null;
  }

  private onCancel(taskId: string): void {
    const work = this.work.get(taskId);
    if (!work) {
      this.world.stats.cancelsStale += 1;
      return;
    }
    if (work.timer) this.world.cancel(work.timer);
    this.clearDeadline(work);
    this.work.delete(taskId);
    this.world.stats.cancelsHonoured += 1;
  }

  private onCommand(op: "close" | "freeze" | "throttle" | "resume"): void {
    this.world.note(`${this.describe()} commanded ${op}`);
    switch (op) {
      case "close":
        if (this.sock) {
          this.world.close(this.sock);
          this.dropConnection();
        }
        // The host tab restarts its worker: back as a new node after the backoff.
        this.rejoinTimer = this.world.after(
          this.world.between(LIMITS.reconnectMinMs, 3_000),
          () => {
            this.rejoinTimer = null;
            if (this.autoRejoin) this.join();
          },
        );
        return;
      case "freeze":
        // Terminal (design §4): no heartbeat, no compute, socket left open. The control plane
        // declares it gone and hangs up; the host then reconnects a fresh worker.
        this.commanded = "freeze";
        this.pause();
        return;
      case "throttle": {
        // A frozen worker runs no loop to slow down: freeze is terminal until the socket drops.
        if (this.commanded === "freeze") return;
        const before = this.multiplier();
        this.commanded = "throttle";
        this.retime(before);
        return;
      }
      case "resume": {
        // Likewise: only a throttled worker resumes. `resumeAll` never revives a frozen one.
        if (this.commanded !== "throttle") return;
        const before = this.multiplier();
        this.commanded = null;
        this.retime(before);
        this.unpause();
        return;
      }
    }
  }

  private onPresigned(urls: Array<{ hash: string; url: string | null }>): void {
    for (const { hash, url } of urls) {
      for (const work of this.work.values()) {
        if (!work.awaiting.has(hash)) continue;
        const blob = work.blobs.get(hash);
        if (url !== null && blob) {
          const stored = this.world.store.put(blob.bytes);
          if (stored !== hash)
            this.world.violation(`${this.describe()} uploaded ${hash.slice(0, 8)} as ${stored}`);
        }
        this.uploaded.add(hash);
        work.awaiting.delete(hash);
        if (work.awaiting.size === 0) {
          // The PUT takes a moment; the result follows it.
          this.world.after(this.world.between(10, 60), () => this.report(work));
        }
      }
    }
  }

  // --- compute ---

  private multiplier(): number {
    return this.profile.speed * (this.commanded === "throttle" ? 10 : 1) * (this.hidden ? 4 : 1);
  }

  private duration(msg: Assign): number {
    const base = this.world.taskCost(msg.taskId, msg.kind);
    const jitter = 0.85 + 0.3 * this.world.random();
    return Math.max(1, Math.round(base * this.multiplier() * jitter));
  }

  private startTimer(work: Work): void {
    work.startedAt = this.world.now;
    work.timer = this.world.after(work.remainingMs, () => {
      work.timer = null;
      this.finish(work.msg.taskId);
    });
  }

  private pause(): void {
    for (const work of this.work.values()) {
      if (!work.timer) continue;
      work.remainingMs = Math.max(1, work.startedAt + work.remainingMs - this.world.now);
      this.world.cancel(work.timer);
      work.timer = null;
    }
  }

  /** Restart every computation the node stopped: safe to call whenever it stops being paused. */
  private unpause(): void {
    if (this.paused || !this.sock) return;
    for (const work of this.work.values()) {
      if (work.phase === "computing" && !work.timer) this.startTimer(work);
    }
  }

  /** The speed changed: stretch or shrink what is left of every running computation. */
  private retime(before: number): void {
    const factor = this.multiplier() / before;
    if (factor === 1) return;
    for (const work of this.work.values()) {
      if (!work.timer) continue;
      const left = Math.max(1, work.startedAt + work.remainingMs - this.world.now);
      this.world.cancel(work.timer);
      work.remainingMs = Math.max(1, Math.round(left * factor));
      this.startTimer(work);
    }
  }

  private manifestFor(root: string | null): FsManifest {
    if (root === null) return EMPTY_MANIFEST;
    const cached = this.manifests.get(root);
    if (cached) return cached;
    const bytes = this.world.store.get(root);
    if (!bytes) return EMPTY_MANIFEST;
    const parsed = fsManifest.parse(JSON.parse(new TextDecoder().decode(bytes)));
    this.manifests.set(root, parsed);
    return parsed;
  }

  private finish(taskId: string): void {
    const work = this.work.get(taskId);
    if (work?.phase !== "computing" || !this.sock) return;
    const msg = work.msg;
    const computeMs = Math.max(1, this.world.now - work.assignedAt);
    const input =
      msg.kind === "run"
        ? encodeRunInput({
            stage: msg.stage,
            taskIndex: msg.index,
            taskCount: msg.count,
            input: fromBase64(msg.input),
          })
        : fromBase64(msg.input);
    const computed = compute(
      this.world.program,
      msg.kind,
      input,
      msg.fsRoot,
      this.manifestFor(msg.fsRoot),
      this.reader,
      msg.limits,
    );
    this.clearDeadline(work);
    if (!computed.ok) {
      this.work.delete(taskId);
      this.world.stats.errors += 1;
      this.world.send(this.sock, {
        t: "result",
        taskId,
        attempt: msg.attempt,
        error: computed.error.slice(0, 1024),
        computeMs,
      });
      return;
    }
    let output = computed.output;
    if (this.profile.liar && msg.kind === "run") output = this.lie(output, input);
    const outputHash = sha256(output);
    const writes = [...computed.writes].map(([path, bytes]) => ({
      path,
      hash: sha256(bytes),
      size: bytes.length,
      bytes,
    }));
    let log: { text: string } | { hash: string } | null = null;
    let logBlob: Blob | null = null;
    if (computed.log.length > 0) {
      if (byteLength(computed.log) <= LIMITS.maxInlineLogBytes) log = { text: computed.log };
      else {
        const bytes = new TextEncoder().encode(computed.log);
        logBlob = { hash: sha256(bytes), bytes };
        log = { hash: logBlob.hash };
      }
    }
    work.result = {
      t: "result",
      taskId,
      attempt: msg.attempt,
      output: outputHash,
      outputSize: output.length,
      writes: writes.map(({ path, hash, size }) => ({ path, hash, size })),
      log,
      computeMs,
    };
    work.phase = "uploading";
    const candidates: Blob[] = [{ hash: outputHash, bytes: output }, ...writes];
    if (logBlob) candidates.push(logBlob);
    const items: Array<{ hash: string; size: number }> = [];
    for (const blob of candidates) {
      if (this.uploaded.has(blob.hash)) continue;
      if (blob.bytes.length === 0) {
        // Presign needs a positive size; an empty blob is put directly.
        this.world.store.put(blob.bytes);
        this.uploaded.add(blob.hash);
        continue;
      }
      work.blobs.set(blob.hash, blob);
      work.awaiting.add(blob.hash);
      items.push({ hash: blob.hash, size: blob.bytes.length });
    }
    if (items.length === 0) this.report(work);
    else this.world.send(this.sock, { t: "presign", items });
  }

  private report(work: Work): void {
    const taskId = work.msg.taskId;
    if (this.work.get(taskId) !== work || !this.sock || !work.result) return;
    this.work.delete(taskId);
    this.tasksDone += 1;
    this.lastTaskMs = work.result.computeMs as number;
    this.world.send(this.sock, work.result);
  }

  /**
   * A consistent liar: the same wrong bytes for the same input, on most inputs, and its own wrong
   * bytes (two liars are two independent faults, not a cartel: D7 assumes an honest majority).
   */
  private lie(output: Uint8Array, input: Uint8Array): Uint8Array {
    const h = sha256(input);
    if (Number.parseInt(h.slice(0, 2), 16) % 4 === 0 || output.length === 0) return output;
    const who = sha256(new TextEncoder().encode(this.profile.hostId));
    const copy = output.slice();
    const pos =
      (Number.parseInt(h.slice(2, 8), 16) + Number.parseInt(who.slice(0, 6), 16)) % copy.length;
    const flip = 1 + (Number.parseInt(who.slice(6, 8), 16) % 255);
    copy[pos] = (copy[pos] as number) ^ flip;
    this.world.stats.liesTold += 1;
    this.world.recordLie(sha256(copy));
    return copy;
  }

  // --- heartbeat ---

  private scheduleHeartbeat(): void {
    this.heartbeatTimer = this.world.after(this.heartbeatMs, () => {
      this.heartbeatTimer = null;
      if (!this.sock || !this.nodeId) return;
      if (!this.paused) {
        this.world.send(this.sock, {
          t: "heartbeat",
          visible: !this.hidden,
          queue: Math.min(this.work.size, LIMITS.maxInFlight),
          lastTaskMs: this.lastTaskMs,
          tasksDone: this.tasksDone,
        });
      }
      this.scheduleHeartbeat();
    });
  }

  /** Forget the connection: a reconnecting node is a new node, commands included. */
  private dropConnection(): void {
    this.sock = null;
    this.nodeId = null;
    this.commanded = null;
    if (this.heartbeatTimer) {
      this.world.cancel(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const work of this.work.values()) {
      if (work.timer) this.world.cancel(work.timer);
      this.clearDeadline(work);
    }
    this.work.clear();
  }
}
