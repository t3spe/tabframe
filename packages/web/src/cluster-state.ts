// The dashboard's model of the cluster, built from snapshots and events: the wire reducer and the
// types it produces. Pure and unit-tested; the selectors and the copy live beside it.
import type {
  ControlPlaneToObserver,
  Counters,
  ExecutionView,
  MachineView,
  NodeView,
  ProgramView,
  QueueEntry,
  Snapshot,
  TaskLog,
  TaskView,
} from "@tabframe/protocol";

/** Throughput is computed on the dashboard from `taskDone` arrival times over this window (design §6.7). */
export const THROUGHPUT_WINDOW_MS = 5_000;
/** How long a reassignment, a retraction, or a control's victims stay highlighted. */
export const FLASH_MS = 1_500;
/** The throughput chart looks back this far, one bucket per second (design §6.7). */
export const CHART_WINDOW_MS = 60_000;
/** Flash-worthy events kept for the pulse list beside the grid. */
export const PULSE_CAP = 12;
/** Notable events kept for the activity list; the activity tab promises the last few hundred lines. */
export const ACTIVITY_CAP = 400;
/** Attempt records kept per task; a task that churns more than this keeps the latest. */
export const HISTORY_CAP = 16;

/** What became of one attempt at a task, as the event stream told it (design §6.4, §6.5). */
export type AttemptOutcome =
  | "running"
  | "done"
  | "verified"
  | "released"
  | "mismatch"
  | "retracted"
  | "cancelled"
  | "failed";

export interface AttemptRecord {
  attempt: number;
  nodeId: string;
  speculative: boolean;
  outcome: AttemptOutcome;
  /** Dashboard clock when the attempt started (or when the snapshot reported it). */
  at: number;
  computeMs: number | null;
  /** Reconstructed from a snapshot's holders rather than seen as an event. */
  fromSnapshot: boolean;
}

/** Why a task flashed: the event that moved it (design §6.4, §6.5, §6.7). */
export type FlashKind = "released" | "speculated" | "verified" | "mismatch";

/** One flash, kept so the reader can see what just moved after the cell has stopped blinking. */
export interface Pulse {
  at: number;
  seq: number;
  taskId: string;
  kind: FlashKind;
  nodeId: string;
}

/** A task as the dashboard knows it: the wire view plus what the event history added. */
export interface TaskState extends TaskView {
  /** A twin agreed with the accepted result. */
  verified: boolean;
  /** Dashboard clock at the last flash-worthy event; drives the flash. */
  flashAt: number | null;
  flashKind: FlashKind | null;
  /** Taken back from a node and not handed out again yet (the scheduler's tier one). */
  released: boolean;
  /** Dashboard clock when the accepted result landed; null until then. */
  settledAt: number | null;
  computeMs: number | null;
  failure: string | null;
  /** Every attempt the dashboard saw, oldest first, capped at HISTORY_CAP. */
  history: AttemptRecord[];
  /** The accepted result's log when the wire carried one; null until the core forwards it. */
  log: TaskLog;
}

/** The eight task colors of the grid, in the order a task normally passes through them. */
export type TaskColor =
  | "pending"
  | "assigned"
  | "speculated"
  | "released"
  | "done"
  | "verified"
  | "mismatch"
  | "failed";

/** `stopped`: ended by a person's Stop — over, but not a failure. */
export type Phase = "planning" | "running" | "folding" | "done" | "failed" | "stopped";

/** Planning, running, and folding are "running" to a visitor: something is happening on the stage. */
export function isRunningPhase(phase: Phase): boolean {
  return phase === "planning" || phase === "running" || phase === "folding";
}

export type StageStatus = "running" | "folding" | "done" | "failed";

/** One stage of the current execution for the strip: what it was called, how it went, its root. */
export interface StageState {
  stage: number;
  name: string;
  taskCount: number;
  /** Run tasks done by the time the stage folded (or so far, for the current stage). */
  done: number;
  failed: number;
  /** The filesystem root the fold produced. */
  root: string | null;
  status: StageStatus;
  /** False for a stage the dashboard did not watch (it joined later); the name is then blank. */
  known: boolean;
}

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
  /** Non-fatal things the control plane said about this execution (design §5.4). */
  warnings: string[];
  /** Stages in order; the last one is the current or final stage. */
  stages: StageState[];
}

/** A program the machine can launch, from the snapshot or a `programAdded` event. */
export interface ProgramInfo {
  bundle: string;
  name: string;
  /** Null until a snapshot describes the program; `programAdded` carries only the name. */
  view: ProgramView["view"] | null;
  description: string | null;
  defaultParams: Record<string, unknown>;
  /** The program's source text in the store, by hash, when it has one. */
  source: string | null;
}

/** The last execution that failed, kept until one succeeds so the reader sees what went wrong. */
export interface Failure {
  executionId: string;
  programName: string;
  reason: string;
  at: number;
}

export type ActivityKind = "control" | "execution" | "task" | "node" | "system" | "error";

export interface Activity {
  at: number;
  seq: number;
  kind: ActivityKind;
  text: string;
}

/** The dashboard's model of the cluster, built from snapshots and events. */
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
  /** The same arrivals over the chart window, oldest first. */
  doneLog: number[];
  /** Flashes, oldest first, capped at PULSE_CAP. */
  pulses: Pulse[];
  /** Notable events, oldest first, capped at ACTIVITY_CAP. */
  activity: Activity[];
  /** Nodes named by the last control, for the flash. */
  victims: { op: string; nodeIds: string[]; at: number } | null;
  rotation: { next: number; reconnectAfterMs: number; at: number } | null;
  sleeping: string | null;
  /** Programs the machine can launch: bundle hash → program. */
  programs: Map<string, ProgramInfo>;
  lastFailure: Failure | null;
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
    doneLog: [],
    pulses: [],
    activity: [],
    victims: null,
    rotation: null,
    sleeping: null,
    programs: new Map(),
    lastFailure: null,
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
        `${msg.entry.programName} queued${msg.entry.human ? " by a person" : ""} (${msg.entry.executionId})${state.machine?.paused ? " · waits for the editor's pause to end" : ""}`,
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
      for (const t of msg.tasks) tasks.set(t.taskId, toTaskState(t, now));
      next.tasks = tasks;
      const stages = stagesUpTo(exec.stages, msg.stage);
      stages[msg.stage] = {
        stage: msg.stage,
        name: msg.name,
        taskCount: msg.taskCount,
        done: 0,
        failed: 0,
        root: null,
        status: "running",
        known: true,
      };
      next.execution = {
        ...exec,
        phase: "running",
        stage: msg.stage,
        stageName: msg.name,
        taskCount: msg.taskCount,
        canvas: msg.canvas,
        counters: { ...exec.counters, pending: exec.counters.pending + msg.taskCount },
        idBase: inferIdBase(msg.tasks),
        stages,
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
      const stages = stagesUpTo(exec.stages, msg.stage);
      const current = stages[msg.stage] ?? unknownStage(msg.stage);
      stages[msg.stage] = {
        ...current,
        done: current.known ? Math.max(current.done, doneRunTasks(next, msg.stage)) : current.done,
        root: msg.root,
        status: "done",
      };
      next.execution = { ...exec, phase: "folding", root: msg.root, stages };
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
          stages: exec.stages.map((s) =>
            s.status === "running" || s.status === "folding"
              ? { ...s, status: "done", root: s.root ?? msg.root }
              : s,
          ),
        };
      }
      // A success clears the failure banner: the machine has moved on and it worked.
      next.lastFailure = null;
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
      const queued = next.queue.find((q) => q.executionId === msg.executionId);
      // A queued execution that ends (dropped by an operator) leaves the queue; only the running
      // one gets the banner — a deliberate drop is not something to warn about.
      next.queue = next.queue.filter((q) => q.executionId !== msg.executionId);
      if (exec && exec.executionId === msg.executionId) {
        const stopped = msg.reason === "stopped by a person";
        next.execution = {
          ...exec,
          phase: stopped ? "stopped" : "failed",
          status: "failed",
          failure: stopped ? null : msg.reason,
          stages: exec.stages.map((s) =>
            s.status === "running" || s.status === "folding" ? { ...s, status: "failed" } : s,
          ),
        };
        // A stop is what the person asked for, not a failure to show in red.
        if (!stopped)
          next.lastFailure = {
            executionId: msg.executionId,
            programName: exec.programName,
            reason: msg.reason,
            at: now,
          };
      }
      const name =
        exec?.executionId === msg.executionId
          ? exec.programName
          : (queued?.programName ?? msg.executionId);
      return note(next, now, "execution", `${name} failed: ${msg.reason}`);
    }
    case "executionWarning": {
      // Visible, not fatal (design §5.4): the run continues with whatever it could start from.
      const next = advance(state, msg.seq);
      const exec = next.execution;
      if (exec && exec.executionId === msg.executionId) {
        next.execution = { ...exec, warnings: [...exec.warnings, msg.message] };
      }
      return note(next, now, "execution", `warning: ${msg.message}`);
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
      const task = ensureTask(next, msg.taskId);
      if (task.status === "pending") bump(next, { pending: -1, assigned: 1 });
      setTask(next, {
        ...task,
        status: task.status === "pending" ? "assigned" : task.status,
        holders: [...task.holders.filter((h) => h !== msg.nodeId), msg.nodeId],
        attempts: Math.max(task.attempts + 1, msg.attempt),
        released: false,
        history: pushAttempt(task.history, {
          attempt: msg.attempt,
          nodeId: msg.nodeId,
          speculative: false,
          outcome: "running",
          at: now,
          computeMs: null,
          fromSnapshot: false,
        }),
      });
      return next;
    }
    case "taskSpeculated": {
      const next = advance(state, msg.seq);
      const task = ensureTask(next, msg.taskId);
      if (task.status === "pending") bump(next, { pending: -1, assigned: 1 });
      bump(next, { speculated: 1 });
      setTask(next, {
        ...task,
        status: task.status === "pending" ? "assigned" : task.status,
        holders: [...task.holders.filter((h) => h !== msg.nodeId), msg.nodeId],
        attempts: task.attempts + 1,
        released: false,
        flashAt: now,
        flashKind: "speculated",
        history: pushAttempt(task.history, {
          attempt: task.attempts + 1,
          nodeId: msg.nodeId,
          speculative: true,
          outcome: "running",
          at: now,
          computeMs: null,
          fromSnapshot: false,
        }),
      });
      pulse(next, now, msg.taskId, "speculated", msg.nodeId);
      return next;
    }
    case "taskDone": {
      const next = advance(state, msg.seq);
      const task = ensureTask(next, msg.taskId);
      if (task.status === "assigned") bump(next, { assigned: -1, done: 1 });
      else if (task.status === "pending") bump(next, { pending: -1, done: 1 });
      // The winner's attempt is done; any twin still running is cancelled by the core (§6.5). A
      // winner the dashboard never saw take the task (it joined late) is recorded, so the ledger
      // can still say who computed the result.
      const seen = task.history.some((a) => a.nodeId === msg.nodeId && a.outcome === "running");
      const closed = seen
        ? settle(task.history, msg.nodeId, "done", msg.computeMs)
        : pushAttempt(task.history, {
            attempt: task.history.length + 1,
            nodeId: msg.nodeId,
            speculative: false,
            outcome: "done",
            at: now,
            computeMs: msg.computeMs,
            fromSnapshot: false,
          });
      const history = closed.map((a) =>
        a.outcome === "running" ? { ...a, outcome: "cancelled" as const } : a,
      );
      setTask(next, {
        ...task,
        status: "done",
        output: msg.output,
        place: msg.place ?? task.place,
        holders: [],
        released: false,
        settledAt: now,
        computeMs: msg.computeMs,
        log: msg.log ?? task.log,
        history,
      });
      next.doneAt = [...pruneTo(next.doneAt, now, THROUGHPUT_WINDOW_MS), now];
      next.doneLog = [...pruneTo(next.doneLog, now, CHART_WINDOW_MS), now];
      resultFrom(next, msg.nodeId, msg.computeMs);
      if (task.kind === "run") bumpStage(next, task.stage, { done: 1 });
      return next;
    }
    case "taskReassigned": {
      const next = advance(state, msg.seq);
      const task = ensureTask(next, msg.taskId);
      const holders = task.holders.filter((h) => h !== msg.fromNode);
      const released = task.status === "assigned" && holders.length === 0;
      if (released) bump(next, { assigned: -1, pending: 1, reassigned: 1 });
      setTask(next, {
        ...task,
        status: released ? "pending" : task.status,
        holders,
        released: released || task.released,
        flashAt: now,
        flashKind: "released",
        history: settle(task.history, msg.fromNode, "released", null),
      });
      pulse(next, now, msg.taskId, "released", msg.fromNode);
      return note(next, now, "task", `${msg.taskId} taken back from ${msg.fromNode}`);
    }
    case "taskVerified": {
      const next = advance(state, msg.seq);
      bump(next, { verified: 1 });
      const task = next.tasks.get(msg.taskId);
      if (task) {
        setTask(next, {
          ...task,
          verified: true,
          flashAt: now,
          flashKind: "verified",
          history: settleOrRecord(task.history, msg.nodeId, "verified", now),
        });
        pulse(next, now, msg.taskId, "verified", msg.nodeId);
      }
      resultFrom(next, msg.nodeId, null);
      return next;
    }
    case "taskMismatch": {
      const next = advance(state, msg.seq);
      const task = ensureTask(next, msg.taskId);
      // The core sends no mismatch for a failed task; one that arrives anyway must not count the
      // task as pending and failed at once.
      if (task.status === "failed") return next;
      bump(next, { mismatched: 1 });
      if (task.status === "done") bump(next, { done: -1, pending: 1 });
      else if (task.status === "assigned") bump(next, { assigned: -1, pending: 1 });
      if (task.status === "done" && task.kind === "run") bumpStage(next, task.stage, { done: -1 });
      // The accepted result is withdrawn along with the disagreeing one: both are suspect now.
      const history = settleOrRecord(task.history, msg.nodeId, "mismatch", now).map((a) =>
        a.outcome === "done" || a.outcome === "verified" || a.outcome === "running"
          ? { ...a, outcome: "retracted" as const }
          : a,
      );
      setTask(next, {
        ...task,
        status: "pending",
        output: null,
        holders: [],
        contested: true,
        verified: false,
        released: false,
        settledAt: null,
        flashAt: now,
        flashKind: "mismatch",
        history,
      });
      pulse(next, now, msg.taskId, "mismatch", msg.nodeId);
      resultFrom(next, msg.nodeId, null);
      return note(next, now, "task", `${msg.taskId} results disagree (${msg.nodeId}); recomputing`);
    }
    case "taskFailed": {
      const next = advance(state, msg.seq);
      const task = ensureTask(next, msg.taskId);
      if (task.status === "assigned") bump(next, { assigned: -1, failed: 1 });
      else if (task.status === "pending") bump(next, { pending: -1, failed: 1 });
      setTask(next, {
        ...task,
        status: "failed",
        holders: [],
        failure: msg.reason,
        history: task.history.map((a) =>
          a.outcome === "running" ? { ...a, outcome: "failed" as const } : a,
        ),
      });
      if (task.kind === "run") bumpStage(next, task.stage, { failed: 1 });
      return note(next, now, "task", `${msg.taskId} failed: ${msg.reason}`);
    }
    case "controlApplied": {
      const next = advance(state, msg.seq);
      next.victims = { op: msg.op, nodeIds: msg.nodeIds, at: now };
      if (msg.op === "setRedundancy") next.refresh = true;
      // Stop and Start carry the machine's new state themselves.
      if ((msg.op === "stop" || msg.op === "start") && next.machine)
        next.machine = {
          ...next.machine,
          stopped: msg.op === "stop",
          yielded: msg.op === "start" ? false : next.machine.yielded,
        };
      if ((msg.op === "pause" || msg.op === "resume") && next.machine)
        next.machine = { ...next.machine, paused: msg.op === "pause" };
      const who = msg.nodeIds.length ? `: ${msg.nodeIds.join(" ")}` : "";
      // The line says what the control did, in the words of the page (rule R2).
      const said =
        msg.op === "stop"
          ? `stop: ${state.execution && isRunningPhase(state.execution.phase) ? `${state.execution.executionId} ended, ` : ""}the loop is held until Start; a launch still runs at once`
          : msg.op === "start"
            ? "start: the loop runs again"
            : msg.op === "pause"
              ? "pause: an editor tab holds the machine; in-flight tasks finish, nothing new starts"
              : msg.op === "resume"
                ? "resume: the editor's pause is lifted"
                : `${msg.op}${who}`;
      return note(next, now, "control", said);
    }
    case "programAdded": {
      const next = advance(state, msg.seq);
      const known = next.programs.get(msg.program);
      next.programs = new Map(next.programs).set(msg.program, {
        bundle: msg.program,
        name: msg.name,
        view: known?.view ?? null,
        description: known?.description ?? null,
        defaultParams: known?.defaultParams ?? {},
        source: known?.source ?? null,
      });
      return note(next, now, "system", `program ${msg.name} added (${msg.program.slice(0, 8)}…)`);
    }
    case "programRetired": {
      const next = advance(state, msg.seq);
      const programs = new Map(next.programs);
      programs.delete(msg.program);
      next.programs = programs;
      return note(next, now, "system", `program ${msg.name} retired (${msg.program.slice(0, 8)}…)`);
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
    case "loopYielded": {
      // The loop yielded to a person's launch, or took the stage back after ten quiet minutes;
      // snapshots carry the same flag for pages that subscribe later.
      const next = advance(state, msg.seq);
      if (next.machine) next.machine = { ...next.machine, yielded: msg.yielded };
      return note(
        next,
        now,
        "system",
        msg.yielded
          ? "the loop yielded to you: the result stays until Start or ten quiet minutes"
          : "ten quiet minutes: the loop is back",
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

/** The failure a snapshot carries, if its execution failed for a reason other than a person's stop. */
function seededFailure(snap: Snapshot, now: number): ClusterState["lastFailure"] {
  const view = snap.execution;
  if (!view?.failure) return null;
  const failed = view.status === "failed" || view.status === "cancelled";
  if (!failed || view.failure === "stopped by a person") return null;
  return {
    executionId: view.executionId,
    programName: view.programName,
    reason: view.failure,
    at: now,
  };
}

function applySnapshot(state: ClusterState, snap: Snapshot, now: number): ClusterState {
  const first = snap.page === 0;
  const nodes = first ? new Map<string, NodeView>() : new Map(state.nodes);
  for (const n of snap.nodes ?? []) nodes.set(n.nodeId, n);
  const tasks = first ? new Map<string, TaskState>() : new Map(state.tasks);
  for (const t of snap.tasks) tasks.set(t.taskId, toTaskState(t, now, true));
  let execution = first
    ? snap.execution
      ? toExecutionState(snap.execution)
      : null
    : state.execution;
  if (execution) {
    const rows = [...tasks.values()].filter(
      (t) => t.stage === execution?.stage && t.kind === "run",
    );
    const current = execution.stages[execution.stage];
    if (current) {
      current.done = rows.filter((t) => t.status === "done").length;
      current.failed = rows.filter((t) => t.status === "failed").length;
    }
    execution = { ...execution, idBase: inferIdBase(rows) };
  }
  let programs = state.programs;
  if (first && snap.programs) {
    programs = new Map(
      snap.programs.map((p) => [
        p.bundle,
        {
          bundle: p.bundle,
          name: p.name,
          view: p.view,
          description: p.description,
          defaultParams: p.defaultParams,
          source: p.source ?? null,
        },
      ]),
    );
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
    // Seeded from the snapshot, so a page that joins after a failure sees why.
    lastFailure: first ? seededFailure(snap, now) : state.lastFailure,
    queue: first ? (snap.queue ?? []) : state.queue,
    machine: first ? (snap.machine ?? null) : state.machine,
    tasks,
    doneAt: pruneTo(state.doneAt, now, THROUGHPUT_WINDOW_MS),
    doneLog: pruneTo(state.doneLog, now, CHART_WINDOW_MS),
    rotation: first ? null : state.rotation,
    sleeping: first ? null : state.sleeping,
    programs,
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

/** A flash-worthy event: remembered for the pulse list beside the grid. */
function pulse(
  next: ClusterState,
  now: number,
  taskId: string,
  kind: FlashKind,
  nodeId: string,
): void {
  const pulses = [...next.pulses, { at: now, seq: next.seq, taskId, kind, nodeId }];
  if (pulses.length > PULSE_CAP) pulses.splice(0, pulses.length - PULSE_CAP);
  next.pulses = pulses;
}

/** The dashboard's execution from the wire's view: a phase, and what it knows of the stages so far. */
export function toExecutionState(view: ExecutionView): ExecutionState {
  const phase: Phase =
    view.status === "done"
      ? "done"
      : view.status === "cancelled" && view.failure === "stopped by a person"
        ? "stopped"
        : view.status === "failed" || view.status === "cancelled"
          ? "failed"
          : view.taskCount > 0
            ? "running"
            : "planning";
  // A snapshot says which stage is current but not what came before: earlier stages are folded
  // and unnamed; the current one is known only if its tasks exist.
  const stages: StageState[] = [];
  for (let i = 0; i < view.stage; i++) stages.push(unknownStage(i));
  if (view.taskCount > 0) {
    stages[view.stage] = {
      stage: view.stage,
      name: view.stageName,
      taskCount: view.taskCount,
      done: 0,
      failed: 0,
      root: phase === "done" ? view.root : null,
      status:
        phase === "done"
          ? "done"
          : phase === "failed" || phase === "stopped"
            ? "failed"
            : "running",
      known: true,
    };
  }
  return {
    ...view,
    phase,
    // A stop carries no failure; any other end keeps the wire's reason, so a page joining after a
    // failure reads the reason rather than "failed: failed".
    failure: phase === "stopped" ? null : (view.failure ?? null),
    followUp: null,
    budget: null,
    idBase: null,
    warnings: [],
    stages,
  };
}

function unknownStage(stage: number): StageState {
  return {
    stage,
    name: "",
    taskCount: 0,
    done: 0,
    failed: 0,
    root: null,
    status: "done",
    known: false,
  };
}

/** A copy of the stage list with every index below `stage` present (unknown ones synthesized). */
function stagesUpTo(stages: readonly StageState[], stage: number): StageState[] {
  const out = [...stages];
  for (let i = 0; i <= stage; i++) if (!out[i]) out[i] = unknownStage(i);
  return out;
}

function toTaskState(view: TaskView, now: number, fromSnapshot = false): TaskState {
  // A snapshot row names its holders but not the attempts they run; reconstruct what it can.
  const history: AttemptRecord[] = view.holders.map((nodeId, i) => ({
    attempt: Math.max(1, view.attempts - view.holders.length + i + 1),
    nodeId,
    speculative: i > 0,
    outcome: "running",
    at: now,
    computeMs: null,
    fromSnapshot,
  }));
  return {
    ...view,
    verified: false,
    flashAt: null,
    flashKind: null,
    released: false,
    settledAt: null,
    computeMs: null,
    failure: null,
    history,
    log: view.log ?? null,
  };
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
function ensureTask(next: ClusterState, taskId: string): TaskState {
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
    flashKind: null,
    released: false,
    settledAt: null,
    computeMs: null,
    failure: null,
    history: [],
    log: null,
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

/** Per-stage tallies for the strip; only the current stage's tasks are in the map. */
function bumpStage(
  next: ClusterState,
  stage: number,
  delta: { done?: number; failed?: number },
): void {
  const exec = next.execution;
  const current = exec?.stages[stage];
  if (!exec || !current) return;
  const stages = [...exec.stages];
  stages[stage] = {
    ...current,
    done: Math.max(0, current.done + (delta.done ?? 0)),
    failed: Math.max(0, current.failed + (delta.failed ?? 0)),
  };
  next.execution = { ...exec, stages };
}

function doneRunTasks(state: ClusterState, stage: number): number {
  let n = 0;
  for (const t of state.tasks.values())
    if (t.stage === stage && t.kind === "run" && t.status === "done") n++;
  return n;
}

function pushAttempt(history: readonly AttemptRecord[], record: AttemptRecord): AttemptRecord[] {
  const out = [...history, record];
  if (out.length > HISTORY_CAP) out.splice(0, out.length - HISTORY_CAP);
  return out;
}

/** Close the running attempt a node holds with an outcome; other attempts are untouched. */
function settle(
  history: readonly AttemptRecord[],
  nodeId: string,
  outcome: AttemptOutcome,
  computeMs: number | null,
): AttemptRecord[] {
  let found = false;
  return history.map((a) => {
    if (found || a.nodeId !== nodeId || a.outcome !== "running") return a;
    found = true;
    return { ...a, outcome, computeMs: computeMs ?? a.computeMs };
  });
}

/**
 * Like `settle`, but a node the dashboard never saw take the task (a twin whose assignment was in a
 * page it missed, or a late duplicate) is recorded so the story has every participant.
 */
function settleOrRecord(
  history: readonly AttemptRecord[],
  nodeId: string,
  outcome: AttemptOutcome,
  now: number,
): AttemptRecord[] {
  if (history.some((a) => a.nodeId === nodeId && a.outcome === "running"))
    return settle(history, nodeId, outcome, null);
  return pushAttempt(history, {
    attempt: history.length + 1,
    nodeId,
    speculative: true,
    outcome,
    at: now,
    computeMs: null,
    fromSnapshot: false,
  });
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

/** Arrival times inside the window, oldest first; the array is shared when nothing fell out. */
function pruneTo(times: readonly number[], now: number, windowMs: number): number[] {
  const floor = now - windowMs;
  let i = 0;
  while (i < times.length && (times[i] as number) <= floor) i++;
  return i === 0 ? [...times] : times.slice(i);
}

/** The page that toggles redundancy knows the value it asked for; the wire's echo carries none. */
export function withRedundancy(state: ClusterState, on: boolean): ClusterState {
  return state.machine ? { ...state, machine: { ...state.machine, redundancy: on } } : state;
}
