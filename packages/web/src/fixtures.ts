// Test-only builders: the wire's views with every field present, and a scripted reducer, so the
// tests do not rebuild them by hand and drift from the schema.
import type {
  ControlPlaneToObserver,
  ExecutionView,
  MachineView,
  NodeView,
  Snapshot,
  TaskView,
} from "@tabframe/protocol";
import { PROTOCOL_VERSION } from "@tabframe/protocol";
import {
  applyMessage,
  type ClusterState,
  type ExecutionState,
  emptyState,
  type Phase,
  type TaskState,
  toExecutionState,
} from "./cluster-state.ts";

export const env = { v: PROTOCOL_VERSION, gen: 2 } as const;
export const HASH = "a".repeat(64);

export const node = (id: string, hostId = "h1", extra: Partial<NodeView> = {}): NodeView => ({
  nodeId: id,
  hostId,
  kind: "tab",
  health: "fast",
  visible: true,
  tasksDone: 0,
  lastTaskMs: null,
  inFlight: 0,
  joinedAt: 1,
  ...extra,
});

export const taskView = (
  taskId: string,
  index: number,
  extra: Partial<TaskView> = {},
): TaskView => ({
  taskId,
  executionId: "e1",
  stage: 0,
  index,
  kind: "run",
  status: "pending",
  holders: [],
  attempts: 0,
  output: null,
  place: { x: index * 64, y: 0, w: 64, h: 64 },
  contested: false,
  ...extra,
});

export const executionView = (extra: Partial<ExecutionView> = {}): ExecutionView => ({
  executionId: "e1",
  program: HASH,
  programName: "mandelbrot",
  status: "running",
  human: false,
  view: "tiles",
  params: { preset: 0 },
  stage: 0,
  stageName: "",
  taskCount: 0,
  canvas: { w: 2048, h: 1280 },
  root: null,
  counters: {
    pending: 0,
    assigned: 0,
    done: 0,
    failed: 0,
    reassigned: 0,
    speculated: 0,
    verified: 0,
    mismatched: 0,
  },
  startedAt: 100,
  ...extra,
});

export type MachineFlags = { stopped?: boolean; yielded?: boolean; paused?: boolean };

export const machine = (flags: MachineFlags = {}): MachineView => ({
  awake: true,
  reason: null,
  redundancy: false,
  stopped: flags.stopped ?? false,
  yielded: flags.yielded ?? false,
  paused: flags.paused ?? false,
  nextRotationAt: null,
  uptimeMs: 0,
});

/** A first snapshot page with nothing on the machine, at `seq`. */
export const snapshot = (seq: number, extra: Partial<Snapshot> = {}): Snapshot => ({
  t: "snapshot",
  ...env,
  seq,
  page: 0,
  pages: 1,
  nodes: [],
  programs: [],
  execution: null,
  queue: [],
  machine: { awake: true, reason: null, redundancy: false, nextRotationAt: null, uptimeMs: 1 },
  tasks: [],
  at: 1,
  ...extra,
});

/** An execution in a phase, built from a wire view so every field is real. */
export const execution = (phase: Phase, extra: Partial<ExecutionView> = {}): ExecutionState => ({
  ...toExecutionState(executionView(extra)),
  phase,
});

/** A state with a machine view, an execution, and `nodes` anonymous nodes. */
export const at = (
  flags: MachineFlags,
  exec: ExecutionState | null = null,
  nodes = 0,
): ClusterState => ({
  ...emptyState(),
  machine: machine(flags),
  execution: exec,
  nodes: new Map(Array.from({ length: nodes }, (_, i) => [`n${i}`, node(`n${i}`)])),
});

/** The task, or a throw: a test that expects one should fail loudly when it is gone. */
export function taskOf(state: ClusterState, id: string): TaskState {
  const task = state.tasks.get(id);
  if (!task) throw new Error(`no task ${id}`);
  return task;
}

type Event = Extract<ControlPlaneToObserver, { seq: number }>;
/** An event without its envelope and sequence number (distributive over the union). */
export type Bare = Event extends infer E
  ? E extends Event
    ? Omit<E, "seq" | "v" | "gen">
    : never
  : never;

/** Applies events with automatic sequence numbers so tests read as a script. */
export class Script {
  state: ClusterState;
  seq: number;
  now: number;
  constructor(seq = 10, now = 1_000) {
    this.seq = seq;
    this.now = now;
    this.state = applyMessage(
      emptyState(),
      snapshot(seq, {
        nodes: [node("n1"), node("n2", "h2")],
        machine: {
          awake: true,
          reason: null,
          redundancy: false,
          nextRotationAt: null,
          uptimeMs: 5,
        },
        at: 0,
      }),
      now,
    );
  }
  send(msg: Bare, dt = 10): ClusterState {
    this.now += dt;
    this.seq += 1;
    const full = { ...msg, ...env, seq: this.seq } as ControlPlaneToObserver;
    this.state = applyMessage(this.state, full, this.now);
    return this.state;
  }
  startStage(count = 4, carried = count): ClusterState {
    this.send({ t: "executionStarted", execution: executionView() });
    const tasks = Array.from({ length: carried }, (_, i) => taskView(`t${i + 1}`, i));
    this.send({
      t: "stageStarted",
      executionId: "e1",
      stage: 0,
      name: "render",
      taskCount: count,
      canvas: { w: 2048, h: 1280 },
      tasks,
    });
    return this.state;
  }
  task(id: string): TaskState {
    return taskOf(this.state, id);
  }
}
