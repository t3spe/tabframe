// What the simulation's virtual clients see of the world, and the counters every run reports.
import type { TaskLimits } from "@tabframe/protocol";
import type { ConnRole } from "../src/ledger.ts";
import type { LoadedProgram } from "./program.ts";
import type { FakeStore } from "./store.ts";

/** A scheduled callback on the virtual timeline. */
export interface Timer {
  at: number;
  seq: number;
  cancelled: boolean;
  run: () => void;
}

/** A virtual node or observer: what the transport delivers to. */
export interface Client {
  /** A text frame from the control plane. */
  receive(raw: string): void;
  /** The control plane hung up. */
  onClosed(code: number, reason: string): void;
}

/**
 * One socket. Each side may close independently: a crashed client stops sending without a close
 * (the control plane finds out through silence), and a control-plane close reaches the client
 * only after the network latency, so both ends can be wrong about each other for a while.
 */
export interface Socket {
  connId: string;
  role: ConnRole;
  client: Client;
  clientOpen: boolean;
  cpOpen: boolean;
  /** Per-direction FIFO: the earliest time the next message in that direction may arrive. */
  toCpAt: number;
  toClientAt: number;
}

export interface SimStats {
  events: number;
  messagesToControlPlane: number;
  messagesToClients: number;
  joins: number;
  leaves: number;
  crashes: number;
  freezes: number;
  hides: number;
  observerJoins: number;
  observerLeaves: number;
  /** Controls sent by observers, by type. */
  controls: Record<string, number>;
  /** Control-plane closes, by close-code name. */
  closes: Record<string, number>;
  framesDone: number;
  framesFailed: number;
  framesCancelled: number;
  /** Execution failure reasons. */
  failures: Record<string, number>;
  /** Summed execution counters. */
  assigned: number;
  done: number;
  reassigned: number;
  speculated: number;
  verified: number;
  mismatched: number;
  cancelsHonoured: number;
  cancelsStale: number;
  errors: number;
  liesTold: number;
  liesAccepted: number;
  peakNodes: number;
  computeMisses: number;
}

export function emptyStats(): SimStats {
  return {
    events: 0,
    messagesToControlPlane: 0,
    messagesToClients: 0,
    joins: 0,
    leaves: 0,
    crashes: 0,
    freezes: 0,
    hides: 0,
    observerJoins: 0,
    observerLeaves: 0,
    controls: {},
    closes: {},
    framesDone: 0,
    framesFailed: 0,
    framesCancelled: 0,
    failures: {},
    assigned: 0,
    done: 0,
    reassigned: 0,
    speculated: 0,
    verified: 0,
    mismatched: 0,
    cancelsHonoured: 0,
    cancelsStale: 0,
    errors: 0,
    liesTold: 0,
    liesAccepted: 0,
    peakNodes: 0,
    computeMisses: 0,
  };
}

export function count(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

/** The world as clients and the chaos generator use it. */
export interface WorldApi {
  readonly now: number;
  readonly gen: number;
  readonly store: FakeStore;
  readonly program: LoadedProgram;
  readonly bundle: string;
  readonly limits: TaskLimits;
  readonly stats: SimStats;
  /** Uniform in [0, 1) from the seed. */
  random(): number;
  /** Uniform integer in [min, max]. */
  between(min: number, max: number): number;
  after(ms: number, run: () => void): Timer;
  cancel(timer: Timer): void;
  connect(client: Client, role: ConnRole): Socket;
  /** Client → control plane, after the network latency, in order per connection. */
  send(sock: Socket, msg: Record<string, unknown>): void;
  /** A clean close: the control plane sees a disconnect once it arrives. */
  close(sock: Socket): void;
  /** A crash: nothing more is sent; the control plane learns through silence. */
  crash(sock: Socket): void;
  violation(text: string): void;
  /** Virtual compute cost of a task in milliseconds, drawn once per task from the seed. */
  taskCost(taskId: string, kind: "run" | "plan"): number;
  /** A liar's output hash, so the checks can tell a lie from a control-plane bug. */
  recordLie(hash: string): void;
  note(text: string): void;
}
