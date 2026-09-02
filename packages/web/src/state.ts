import type {
  ControlPlaneToObserver,
  Counters,
  ExecutionView,
  MachineView,
  NodeView,
  QueueEntry,
  Snapshot,
  TaskView,
} from "@tabframe/protocol";

/** Throughput is computed on the dashboard from `taskDone` arrival times over this window (design §6.7). */
export const THROUGHPUT_WINDOW_MS = 5_000;
/** How long a reassignment, a retraction, or a control's victims stay highlighted. */
export const FLASH_MS = 1_500;
/** Notable events kept for the activity list. */
export const ACTIVITY_CAP = 60;

/** A task as the dashboard knows it: the wire view plus what the event history added. */
export interface TaskState extends TaskView {
  /** A twin agreed with the accepted result. */
  verified: boolean;
  /** Dashboard clock at the last reassignment or retraction; drives the flash. */
  flashAt: number | null;
  computeMs: number | null;
  failure: string | null;
}

/** The seven task colors of the grid, in the order a task normally passes through them. */
export type TaskColor =
  | "pending"
  | "assigned"
  | "speculated"
  | "done"
  | "verified"
  | "mismatch"
  | "failed";

export type Phase = "planning" | "running" | "folding" | "done" | "failed";

export interface ExecutionState extends ExecutionView {
  phase: Phase;
  failure: string | null;
  followUp: Record<string, unknown> | null;
  budget: { used: number; cap: number } | null;
  /**
   * Numeric base of the current stage's task ids when they are consecutive. `stageStarted` carries
   * at most 256 task rows; later rows are placed on the grid from their id until the next snapshot.
   */
  idBase: number | null;
}

export type ActivityKind = "control" | "execution" | "task" | "node" | "system" | "error";

export interface Activity {
  at: number;
  seq: number;
  kind: ActivityKind;
  text: string;
}

/** The dashboard's model of the cluster, built from snapshots and events. Pure and unit-tested. */
export interface ClusterState {
  generation: number | null;
  seq: number;
  nodes: Map<string, NodeView>;
  /** Pages of the snapshot still expected before the view is complete. */
  pagesPending: number;
  /** True once a gap in sequence numbers was seen; the client must resubscribe. */
  gap: boolean;
  /**
   * The machine view went stale: another observer toggled redundancy and only a snapshot carries the
   * value. The client refreshes quietly instead of trusting a guess.
   */
  refresh: boolean;
  execution: ExecutionState | null;
  queue: QueueEntry[];
  machine: MachineView | null;
  /** Tasks of the current execution, keyed by task id. */
  tasks: Map<string, TaskState>;
  /** Dashboard-clock arrival times of `taskDone` inside the throughput window, oldest first. */
  doneAt: number[];
  /** Notable events, oldest first, capped at ACTIVITY_CAP. */
  activity: Activity[];
  /** Nodes named by the last control, for the flash. */
  victims: { op: string; nodeIds: string[]; at: number } | null;
  rotation: { next: number; reconnectAfterMs: number; at: number } | null;
  sleeping: string | null;
  /** Programs announced since the page loaded: bundle hash → name. */
  programs: Map<string, string>;
}

export function emptyState(): ClusterState {
  return {
    generation: null,
    seq: 0,
    nodes: new Map(),
    pagesPending: 0,
    gap: false,
    refresh: false,
    execution: null,
    queue: [],
    machine: null,
    tasks: new Map(),
    doneAt: [],
    activity: [],
    victims: null,
    rotation: null,
    sleeping: null,
    programs: new Map(),
  };
}

export function applyMessage(
  state: ClusterState,
  msg: ControlPlaneToObserver,
  now = Date.now(),
): ClusterState {
  switch (msg.t) {
    case "snapshot":
      return applySnapshot(state, msg, now);
    case "pong":
      if (msg.seq > state.seq) return { ...state, gap: true };
      return state;
    case "error":
      return note(state, now, "error", `${msg.code}: ${msg.message}`);
    case "presigned":
      return state;
    case "nodeJoined": {
      const next = advance(state, msg.seq);
      next.nodes = new Map(next.nodes).set(msg.node.nodeId, msg.node);
      return next;
    }
    case "nodeLeft": {
      const next = advance(state, msg.seq);
      const nodes = new Map(next.nodes);
      nodes.delete(msg.nodeId);
      next.nodes = nodes;
      return note(next, now, "node", `${msg.nodeId} left (${msg.reason})`);
    }
    case "nodeHealth": {
      const next = advance(state, msg.seq);
      const n = next.nodes.get(msg.nodeId);
      if (n) next.nodes = new Map(next.nodes).set(msg.nodeId, { ...n, health: msg.health });
      return next;
    }
    case "executionQueued": {
      const next = advance(state, msg.seq);
      next.queue = [
        ...next.queue.filter((q) => q.executionId !== msg.entry.executionId),
        msg.entry,
      ];
      return note(
        next,
        now,
        "execution",
        `${msg.entry.programName} queued${msg.entry.human ? " by a person" : ""} (${msg.entry.executionId})`,
      );
    }
    case "executionStarted": {
      const next = advance(state, msg.seq);
      next.execution = toExecutionState(msg.execution);
      next.tasks = new Map();
      next.queue = next.queue.filter((q) => q.executionId !== msg.execution.executionId);
      return note(
        next,
        now,
        "execution",
        `${msg.execution.programName} started (${msg.execution.executionId})`,
      );
    }
    case "stageStarted": {
      const next = advance(state, msg.seq);
      const exec = next.execution;
      if (!exec || exec.executionId !== msg.executionId) return next;
      const tasks = new Map<string, TaskState>();
      for (const t of msg.tasks) tasks.set(t.taskId, toTaskState(t));
      next.tasks = tasks;
      next.execution = {
        ...exec,
        phase: "running",
        stage: msg.stage,
        stageName: msg.name,
        taskCount: msg.taskCount,
        canvas: msg.canvas,
        counters: { ...exec.counters, pending: exec.counters.pending + msg.taskCount },
        idBase: inferIdBase(msg.tasks),
      };
      return note(
        next,
        now,
        "execution",
        `stage ${msg.stage} ${msg.name}: ${msg.taskCount} tasks${msg.canvas ? ` on ${msg.canvas.w}×${msg.canvas.h}` : ""}`,
      );
    }
    case "stageDone": {
      const next = advance(state, msg.seq);
      const exec = next.execution;
      if (!exec || exec.executionId !== msg.executionId) return next;
      next.execution = { ...exec, phase: "folding", root: msg.root };
      return next;
    }
    case "executionDone": {
      const next = advance(state, msg.seq);
      const exec = next.execution;
      if (exec && exec.executionId === msg.executionId) {
        next.execution = {
          ...exec,
          phase: "done",
          status: "done",
          root: msg.root,
          followUp: msg.followUp,
        };
      }
      return note(
        next,
        now,
        "execution",
        `${exec?.programName ?? msg.executionId} done${msg.followUp ? ", follow-up offered" : ""}`,
      );
    }
    case "executionFailed": {
      const next = advance(state, msg.seq);
      const exec = next.execution;
      if (exec && exec.executionId === msg.executionId) {
        next.execution = { ...exec, phase: "failed", status: "failed", failure: msg.reason };
      }
      return note(
        next,
        now,
        "execution",
        `${exec?.programName ?? msg.executionId} failed: ${msg.reason}`,
      );
    }
    case "budget": {
      const next = advance(state, msg.seq);
      const exec = next.execution;
      if (exec && exec.executionId === msg.executionId) {
        next.execution = { ...exec, budget: { used: msg.computeMsUsed, cap: msg.computeMsCap } };
      }
      return next;
    }
    case "taskAssigned": {
      const next = advance(state, msg.seq);
      const task = ensureTask(next, msg.taskId, now);
      if (task.status === "pending") bump(next, { pending: -1, assigned: 1 });
      setTask(next, {
        ...task,
        status: task.status === "pending" ? "assigned" : task.status,
        holders: [...task.holders.filter((h) => h !== msg.nodeId), msg.nodeId],
        attempts: Math.max(task.attempts + 1, msg.attempt),
      });
      return next;
    }
    case "taskSpeculated": {
      const next = advance(state, msg.seq);
      const task = ensureTask(next, msg.taskId, now);
      if (task.status === "pending") bump(next, { pending: -1, assigned: 1 });
      bump(next, { speculated: 1 });
      setTask(next, {
        ...task,
        status: task.status === "pending" ? "assigned" : task.status,
        holders: [...task.holders.filter((h) => h !== msg.nodeId), msg.nodeId],
        attempts: task.attempts + 1,
      });
      return next;
    }
    case "taskDone": {
      const next = advance(state, msg.seq);
      const task = ensureTask(next, msg.taskId, now);
      if (task.status === "assigned") bump(next, { assigned: -1, done: 1 });
      else if (task.status === "pending") bump(next, { pending: -1, done: 1 });
      setTask(next, {
        ...task,
        status: "done",
        output: msg.output,
        place: msg.place ?? task.place,
        holders: [],
        computeMs: msg.computeMs,
      });
      next.doneAt = [...prune(next.doneAt, now), now];
      resultFrom(next, msg.nodeId, msg.computeMs);
      return next;
    }
    case "taskReassigned": {
      const next = advance(state, msg.seq);
      const task = ensureTask(next, msg.taskId, now);
      const holders = task.holders.filter((h) => h !== msg.fromNode);
      const released = task.status === "assigned" && holders.length === 0;
      if (released) bump(next, { assigned: -1, pending: 1, reassigned: 1 });
      setTask(next, {
        ...task,
        status: released ? "pending" : task.status,
        holders,
        flashAt: now,
      });
      return note(next, now, "task", `${msg.taskId} taken back from ${msg.fromNode}`);
    }
    case "taskVerified": {
      const next = advance(state, msg.seq);
      bump(next, { verified: 1 });
      const task = next.tasks.get(msg.taskId);
      if (task) setTask(next, { ...task, verified: true });
      resultFrom(next, msg.nodeId, null);
      return next;
    }
    case "taskMismatch": {
      const next = advance(state, msg.seq);
      const task = ensureTask(next, msg.taskId, now);
      bump(next, { mismatched: 1 });
      if (task.status === "done") bump(next, { done: -1, pending: 1 });
      else if (task.status === "assigned") bump(next, { assigned: -1, pending: 1 });
      else if (task.status === "failed") bump(next, { pending: 1 });
      setTask(next, {
        ...task,
        status: "pending",
        output: null,
        holders: [],
        contested: true,
        verified: false,
        flashAt: now,
      });
      resultFrom(next, msg.nodeId, null);
      return note(next, now, "task", `${msg.taskId} results disagree (${msg.nodeId}); recomputing`);
    }
    case "taskFailed": {
      const next = advance(state, msg.seq);
      const task = ensureTask(next, msg.taskId, now);
      if (task.status === "assigned") bump(next, { assigned: -1, failed: 1 });
      else if (task.status === "pending") bump(next, { pending: -1, failed: 1 });
      setTask(next, { ...task, status: "failed", holders: [], failure: msg.reason });
      return note(next, now, "task", `${msg.taskId} failed: ${msg.reason}`);
    }
    case "controlApplied": {
      const next = advance(state, msg.seq);
      next.victims = { op: msg.op, nodeIds: msg.nodeIds, at: now };
      if (msg.op === "setRedundancy") next.refresh = true;
      const who = msg.nodeIds.length ? `: ${msg.nodeIds.join(" ")}` : "";
      return note(next, now, "control", `${msg.op}${who}`);
    }
    case "programAdded": {
      const next = advance(state, msg.seq);
      next.programs = new Map(next.programs).set(msg.program, msg.name);
      return note(next, now, "system", `program ${msg.name} added (${msg.program.slice(0, 8)}…)`);
    }
    case "executionWarning": {
      // Visible, not fatal (design §5.4): the run continues with whatever it could start from.
      const next = advance(state, msg.seq);
      return note(next, now, "execution", `warning: ${msg.message}`);
    }
    case "controlPlaneRotating": {
      const next = advance(state, msg.seq);
      next.rotation = { next: msg.next, reconnectAfterMs: msg.reconnectAfterMs, at: now };
      return note(
        next,
        now,
        "system",
        `control plane rotating to generation ${msg.next}; reconnecting in ${(msg.reconnectAfterMs / 1000).toFixed(1)} s`,
      );
    }
    case "machineSleeping": {
      const next = advance(state, msg.seq);
      next.sleeping = msg.reason;
      return note(next, now, "system", `machine going to sleep: ${msg.reason}`);
    }
    default:
      return unreachable(msg);
  }
}

function unreachable(msg: never): never {
  throw new Error(`unhandled message ${String((msg as { t?: unknown }).t)}`);
}

function applySnapshot(state: ClusterState, snap: Snapshot, now: number): ClusterState {
  const first = snap.page === 0;
  const nodes = first ? new Map<string, NodeView>() : new Map(state.nodes);
  for (const n of snap.nodes ?? []) nodes.set(n.nodeId, n);
  const tasks = first ? new Map<string, TaskState>() : new Map(state.tasks);
  for (const t of snap.tasks) tasks.set(t.taskId, toTaskState(t));
  let execution = first
    ? snap.execution
      ? toExecutionState(snap.execution)
      : null
    : state.execution;
  if (execution) {
    const rows = [...tasks.values()].filter(
      (t) => t.stage === execution?.stage && t.kind === "run",
    );
    execution = { ...execution, idBase: inferIdBase(rows) };
  }
  return {
    ...state,
    generation: snap.gen,
    seq: snap.seq,
    nodes,
    pagesPending: snap.pages - snap.page - 1,
    gap: false,
    refresh: false,
    execution,
    queue: first ? (snap.queue ?? []) : state.queue,
    machine: first ? (snap.machine ?? null) : state.machine,
    tasks,
    doneAt: prune(state.doneAt, now),
    rotation: first ? null : state.rotation,
    sleeping: first ? null : state.sleeping,
  };
}

/** Events must arrive in sequence; a skipped number means a missed event. */
function advance(state: ClusterState, seq: number): ClusterState {
  const gap = state.gap || seq !== state.seq + 1;
  return { ...state, seq: Math.max(state.seq, seq), gap };
}

function note(state: ClusterState, now: number, kind: ActivityKind, text: string): ClusterState {
  const entry: Activity = { at: now, seq: state.seq, kind, text };
  const activity = [...state.activity, entry];
  if (activity.length > ACTIVITY_CAP) activity.splice(0, activity.length - ACTIVITY_CAP);
  return { ...state, activity };
}

function toExecutionState(view: ExecutionView): ExecutionState {
  const phase: Phase =
    view.status === "done"
      ? "done"
      : view.status === "failed" || view.status === "cancelled"
        ? "failed"
        : view.taskCount > 0
          ? "running"
          : "planning";
  return { ...view, phase, failure: null, followUp: null, budget: null, idBase: null };
}

function toTaskState(view: TaskView): TaskState {
  return { ...view, verified: false, flashAt: null, computeMs: null, failure: null };
}

/** `t<n>` ids are handed out consecutively inside a stage; the base lets later rows find their index. */
function inferIdBase(tasks: readonly TaskView[]): number | null {
  if (tasks.length === 0) return null;
  let base: number | null = null;
  for (const t of tasks) {
    const n = numericId(t.taskId);
    if (n === null) return null;
    const candidate = n - t.index;
    if (base === null) base = candidate;
    else if (candidate !== base) return null;
  }
  return base;
}

function numericId(taskId: string): number | null {
  const m = /^t(\d+)$/.exec(taskId);
  return m ? Number(m[1]) : null;
}

/** Copy-on-write for the task map: `next` is already a fresh top-level object. */
function setTask(next: ClusterState, task: TaskState): void {
  next.tasks = new Map(next.tasks).set(task.taskId, task);
}

/**
 * A task the dashboard has not seen: a row `stageStarted` could not carry, or the planner running
 * before the stage exists. It is placed from its id when the base is known and left unplaced otherwise.
 */
function ensureTask(next: ClusterState, taskId: string, _now: number): TaskState {
  const known = next.tasks.get(taskId);
  if (known) return known;
  const exec = next.execution;
  const running = exec?.phase === "running";
  const placeholder: TaskState = {
    taskId,
    executionId: exec?.executionId ?? "",
    stage: exec?.stage ?? 0,
    index: running && exec ? inferIndex(next, exec, taskId) : -1,
    kind: running ? "run" : "plan",
    status: "pending",
    holders: [],
    attempts: 0,
    output: null,
    place: null,
    contested: false,
    verified: false,
    flashAt: null,
    computeMs: null,
    failure: null,
  };
  setTask(next, placeholder);
  return placeholder;
}

function inferIndex(state: ClusterState, exec: ExecutionState, taskId: string): number {
  const n = numericId(taskId);
  if (exec.idBase === null || n === null) return -1;
  const index = n - exec.idBase;
  if (index < 0 || index >= exec.taskCount) return -1;
  for (const t of state.tasks.values()) if (t.stage === exec.stage && t.index === index) return -1;
  return index;
}

function bump(next: ClusterState, delta: Partial<Counters>): void {
  const exec = next.execution;
  if (!exec) return;
  const counters = { ...exec.counters };
  for (const [k, v] of Object.entries(delta) as [keyof Counters, number][]) {
    counters[k] = Math.max(0, counters[k] + v);
  }
  next.execution = { ...exec, counters };
}

/** A node handed in a result: the core counts every result, duplicates included. */
function resultFrom(next: ClusterState, nodeId: string, computeMs: number | null): void {
  const n = next.nodes.get(nodeId);
  if (!n) return;
  next.nodes = new Map(next.nodes).set(nodeId, {
    ...n,
    tasksDone: n.tasksDone + 1,
    lastTaskMs: computeMs ?? n.lastTaskMs,
  });
}

function prune(times: readonly number[], now: number): number[] {
  const floor = now - THROUGHPUT_WINDOW_MS;
  let i = 0;
  while (i < times.length && (times[i] as number) <= floor) i++;
  return i === 0 ? [...times] : times.slice(i);
}

/** The page that toggles redundancy knows the value it asked for; the wire's echo carries none. */
export function withRedundancy(state: ClusterState, on: boolean): ClusterState {
  return state.machine ? { ...state, machine: { ...state.machine, redundancy: on } } : state;
}

// ---- selectors --------------------------------------------------------------------------------

export function hostCount(state: ClusterState): number {
  return new Set([...state.nodes.values()].map((n) => n.hostId)).size;
}

/** Run tasks of the current stage in grid order: placed rows by index, unplaced rows after them by id. */
export function stageTasks(state: ClusterState): TaskState[] {
  const exec = state.execution;
  if (!exec) return [];
  const rows = [...state.tasks.values()].filter((t) => t.stage === exec.stage && t.kind === "run");
  rows.sort((a, b) => {
    if (a.index >= 0 && b.index >= 0) return a.index - b.index;
    if (a.index >= 0) return -1;
    if (b.index >= 0) return 1;
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  });
  return rows;
}

/** The planner's task while a stage is being planned, if the dashboard has seen it. */
export function planTask(state: ClusterState): TaskState | null {
  for (const t of state.tasks.values()) if (t.kind === "plan" && t.status !== "done") return t;
  return null;
}

export function taskColor(task: TaskState): TaskColor {
  switch (task.status) {
    case "failed":
      return "failed";
    case "done":
      return task.verified ? "verified" : "done";
    case "assigned":
      return task.holders.length > 1 ? "speculated" : "assigned";
    default:
      return task.contested ? "mismatch" : "pending";
  }
}

export function isFlashing(at: number | null, now: number): boolean {
  return at !== null && now - at < FLASH_MS;
}

/** Tasks per second over the window, from arrival times. */
export function throughput(state: ClusterState, now: number): number {
  return prune(state.doneAt, now).length / (THROUGHPUT_WINDOW_MS / 1000);
}

/** Open attempts per node, derived from task holders so it never drifts from the grid. */
export function inFlightByNode(state: ClusterState): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of state.tasks.values()) {
    if (t.status !== "assigned") continue;
    for (const h of t.holders) out.set(h, (out.get(h) ?? 0) + 1);
  }
  return out;
}

export function progress(state: ClusterState): { done: number; total: number } {
  const exec = state.execution;
  if (!exec) return { done: 0, total: 0 };
  let done = 0;
  let seen = 0;
  for (const t of state.tasks.values()) {
    if (t.stage !== exec.stage || t.kind !== "run") continue;
    seen++;
    if (t.status === "done") done++;
  }
  return { done, total: Math.max(exec.taskCount, seen) };
}
