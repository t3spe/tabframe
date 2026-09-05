// Task records and their transitions (design §6.3–§6.5). Every status change goes through
// `setStatus`, so an execution's counters follow from the transition and are kept nowhere else.
import { type Place, PROTOCOL_VERSION } from "@tabframe/protocol";
import type { Effect } from "./events.ts";
import type { ExecutionRecord, Ledger, TaskRecord, TaskStatus } from "./ledger.ts";
import { broadcast } from "./observers.ts";

/** A pending task of the execution, counted against its task cap. */
export function newTask(
  ledger: Ledger,
  exec: ExecutionRecord,
  spec: {
    stage: number;
    index: number;
    kind: "run" | "plan";
    input: Uint8Array;
    place: Place | null;
  },
  now: number,
): TaskRecord {
  const taskId = `t${++ledger.meta.taskCounter}`;
  const task: TaskRecord = {
    taskId,
    executionId: exec.executionId,
    stage: spec.stage,
    index: spec.index,
    kind: spec.kind,
    input: spec.input,
    place: spec.place,
    status: "pending",
    attempts: [],
    results: [],
    accepted: null,
    released: false,
    contestedRounds: 0,
    resolvedByVote: false,
    requiredAgreement: ledger.meta.redundancy ? 2 : 1,
    createdAt: now,
    doneAt: null,
    failure: null,
  };
  ledger.tasks.set(taskId, task);
  exec.counters.pending += 1;
  exec.tasksCreated += 1;
  return task;
}

/** Move a task to `next`; the execution's counters follow the transition. */
export function setStatus(exec: ExecutionRecord, task: TaskRecord, next: TaskStatus): void {
  if (task.status === next) return;
  exec.counters[task.status] = Math.max(0, exec.counters[task.status] - 1);
  exec.counters[next] += 1;
  task.status = next;
}

export function runningAttempts(task: TaskRecord): number {
  return task.attempts.filter((a) => a.outcome === "running").length;
}

/** The current stage's tasks plus any plan task in flight, in fill order. */
export function stageTasks(ledger: Ledger, exec: ExecutionRecord): TaskRecord[] {
  const out: TaskRecord[] = [];
  if (exec.planTaskId) {
    const p = ledger.tasks.get(exec.planTaskId);
    if (p) out.push(p);
  }
  for (const id of exec.stageTaskIds) {
    const t = ledger.tasks.get(id);
    if (t) out.push(t);
  }
  return out;
}

/**
 * An attempt went away: with no attempt left running and nothing decided this round, the task
 * goes back to the front (released work outranks fresh work, design §6.4) and observers are told.
 */
export function releaseTask(ledger: Ledger, task: TaskRecord, fromNode: string): Effect[] {
  if (task.status !== "assigned" || runningAttempts(task) > 0) return [];
  if (task.results.some((r) => r.round === task.contestedRounds)) return [];
  const exec = ledger.executions.get(task.executionId);
  if (exec) {
    setStatus(exec, task, "pending");
    exec.counters.reassigned += 1;
  } else task.status = "pending";
  task.released = true;
  return broadcast(ledger, { t: "taskReassigned", taskId: task.taskId, fromNode });
}

/** A program fault: every open attempt is cancelled, the task fails, and observers are told. */
export function failTask(
  ledger: Ledger,
  exec: ExecutionRecord,
  task: TaskRecord,
  reason: string,
  now: number,
): Effect[] {
  const effects = cancelOthers(ledger, task, null);
  setStatus(exec, task, "failed");
  task.failure = reason;
  task.doneAt = now;
  effects.push(...broadcast(ledger, { t: "taskFailed", taskId: task.taskId, reason }));
  return effects;
}

/** Cancel every open attempt of a task except the one to keep; the nodes are told (design §6.5). */
export function cancelOthers(
  ledger: Ledger,
  task: TaskRecord,
  keepNodeId: string | null,
): Effect[] {
  const effects: Effect[] = [];
  for (const a of task.attempts) {
    if (a.outcome !== "running" || a.nodeId === keepNodeId) continue;
    a.outcome = "cancelled";
    const node = ledger.nodes.get(a.nodeId);
    if (node) {
      node.inFlight = node.inFlight.filter((id) => id !== task.taskId);
      effects.push({
        kind: "send",
        connId: node.connId,
        msg: { t: "cancel", v: PROTOCOL_VERSION, gen: ledger.meta.generation, taskId: task.taskId },
      });
    }
  }
  return effects;
}
