import { type Assign, encode, LIMITS, PROTOCOL_VERSION } from "@tabframe/protocol";
import type { Link, Log, Timers } from "./connection.ts";
import type { TaskRunner } from "./tasks.ts";

/** How much slower a throttled node runs: it idles this many times its compute after each task. */
export const THROTTLE_FACTOR = 9;
/** A throttled node idles at least this long between tasks, so tiny tasks still slow down. */
export const THROTTLE_MIN_MS = 50;

export type WorkState = "frozen" | "throttled" | "busy" | "idle";

export interface TaskLoopDeps {
  timers: Timers;
  /** The runner for a store base; a new base replaces the runner. */
  createRunner: (storeBase: string) => TaskRunner;
  /** Where a result goes: the socket the task was assigned over. */
  link: () => Link | null;
  /** Something a status reader wants to know has changed. */
  onChange: () => void;
  log?: Log | undefined;
}

/**
 * The work half of a node (design §4): accept up to `maxInFlight` assignments, run them one at a
 * time, report each result over the link it arrived on. Freeze, throttle, resume and drop act on
 * this queue; the connection owns heartbeats and sockets.
 */
export class TaskLoop {
  private readonly deps: TaskLoopDeps;
  private maxInFlight: number = LIMITS.maxInFlight;
  private queue: Assign[] = [];
  private running: Assign | null = null;
  private isFrozen = false;
  private isThrottled = false;
  private throttleHandle: unknown = null;
  private runner: TaskRunner | null = null;
  private runnerBase: string | null = null;
  private stopped = false;
  private done = 0;
  private lastMs: number | null = null;

  constructor(deps: TaskLoopDeps) {
    this.deps = deps;
  }

  get frozen(): boolean {
    return this.isFrozen;
  }

  get tasksDone(): number {
    return this.done;
  }

  get lastTaskMs(): number | null {
    return this.lastMs;
  }

  /** Tasks accepted and not yet finished, the running one included. */
  held(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  state(visible: boolean): WorkState {
    if (this.isFrozen) return "frozen";
    if (this.isThrottled || !visible) return "throttled";
    return this.running ? "busy" : "idle";
  }

  start(): void {
    this.stopped = false;
  }

  /** A welcome names the capacity and the store base. */
  configure(maxInFlight: number, storeBase: string): void {
    this.maxInFlight = maxInFlight;
    if (this.runner && this.runnerBase === storeBase) return;
    this.runner?.abort();
    this.runner = this.deps.createRunner(storeBase);
    this.runnerBase = storeBase;
  }

  /** Queue an assignment; false when frozen or over capacity (the control plane reassigns). */
  accept(a: Assign): boolean {
    if (this.isFrozen) {
      this.deps.log?.("assign-while-frozen", { taskId: a.taskId });
      return false;
    }
    const held = this.held();
    if (held >= this.maxInFlight) {
      this.deps.log?.("assign-over-capacity", { taskId: a.taskId, held });
      return false;
    }
    this.queue.push(a);
    this.pump();
    return true;
  }

  cancel(taskId: string): void {
    this.queue = this.queue.filter((a) => a.taskId !== taskId);
    if (this.running?.taskId === taskId) this.runner?.abort();
  }

  /** Look dead to the control plane: work is dropped and no result goes out until resume. */
  freeze(): void {
    this.isFrozen = true;
    this.drop();
  }

  throttle(): void {
    this.isThrottled = true;
  }

  /** Undo freeze and throttle; queued work goes on. */
  resume(): void {
    this.isFrozen = false;
    this.isThrottled = false;
    this.deps.timers.clearTimeout(this.throttleHandle);
    this.throttleHandle = null;
    this.pump();
  }

  /** The socket is gone: assignments belong to it, and the modes an operator set with it. */
  disconnect(): void {
    this.drop();
    this.isFrozen = false;
    this.isThrottled = false;
  }

  /** Forget queued work and kill the running task; the control plane reassigns it. */
  drop(): void {
    this.queue = [];
    this.running = null;
    this.runner?.abort();
    this.deps.timers.clearTimeout(this.throttleHandle);
    this.throttleHandle = null;
  }

  stop(): void {
    this.stopped = true;
    this.drop();
  }

  /** Start the next queued task unless one is running, the node is paused, or nothing waits. */
  private pump(): void {
    if (this.running || this.isFrozen || this.throttleHandle || this.stopped) return;
    const next = this.queue.shift();
    if (!next || !this.runner) return;
    this.running = next;
    const link = this.deps.link();
    void this.runner.run(next).then((outcome) => {
      if (this.running !== next) return; // dropped meanwhile
      this.running = null;
      if (outcome.kind === "result") {
        this.done += 1;
        this.lastMs = outcome.msg.computeMs;
        if (link) link.send(encode({ ...outcome.msg, v: PROTOCOL_VERSION, gen: link.generation }));
        if (this.isThrottled) {
          const idle = Math.max(outcome.msg.computeMs * THROTTLE_FACTOR, THROTTLE_MIN_MS);
          this.throttleHandle = this.deps.timers.setTimeout(() => {
            this.throttleHandle = null;
            this.pump();
            this.deps.onChange();
          }, idle);
          this.deps.onChange();
          return;
        }
      }
      this.pump();
      this.deps.onChange();
    });
  }
}
