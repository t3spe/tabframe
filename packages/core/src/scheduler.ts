import { type Assign, type Health, LIMITS, PROTOCOL_VERSION } from "@tabframe/protocol";
import { toBase64 } from "./bytes.ts";
import type { Effect } from "./events.ts";
import type { ExecutionRecord, Ledger, NodeRecord, TaskRecord } from "./ledger.ts";
import { broadcast } from "./observers.ts";

/** Median of the execution's recent compute samples times the factor, floored (design §6.4). */
export function deadlineMs(ledger: Ledger, exec: ExecutionRecord): number {
  const samples = exec.computeSamples;
  if (samples.length === 0) return ledger.config.deadlineFloorMs;
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return Math.max(ledger.config.deadlineFloorMs, Math.round(median * ledger.config.deadlineFactor));
}

export function runningAttempts(task: TaskRecord): number {
  return task.attempts.filter((a) => a.outcome === "running").length;
}

function holds(task: TaskRecord, nodeId: string): boolean {
  return task.attempts.some((a) => a.outcome === "running" && a.nodeId === nodeId);
}

/** Results reported in the current contested round that agree with each other, at most. */
function currentRoundResults(task: TaskRecord): number {
  return task.results.filter((r) => r.round === task.contestedRounds).length;
}

/** How many more attempts this task wants before it can settle. */
export function wanted(task: TaskRecord): number {
  if (task.status === "done" || task.status === "failed") return 0;
  return Math.max(0, task.requiredAgreement - currentRoundResults(task) - runningAttempts(task));
}

/** The node already reported this round: a second attempt there could only agree with itself. */
function answered(task: TaskRecord, nodeId: string): boolean {
  return task.results.some((r) => r.round === task.contestedRounds && r.nodeId === nodeId);
}

function fillable(task: TaskRecord, nodeId: string): boolean {
  return wanted(task) > 0 && !holds(task, nodeId) && !answered(task, nodeId);
}

/** Overdue with exactly one open attempt, nothing wanted: a speculative twin may join (tier three). */
function speculatable(task: TaskRecord, nodeId: string, now: number): boolean {
  if (task.status !== "assigned" || wanted(task) > 0 || answered(task, nodeId)) return false;
  const running = task.attempts.filter((a) => a.outcome === "running");
  if (running.length !== 1) return false;
  const a = running[0];
  return a !== undefined && a.nodeId !== nodeId && now > a.deadlineAt;
}

/** The three-tier choice for one free slot (design §6.3). */
export function pickTask(
  ledger: Ledger,
  node: NodeRecord,
  now: number,
): { task: TaskRecord; speculative: boolean } | null {
  const exec = ledger.running ? ledger.executions.get(ledger.running) : undefined;
  if (!exec) return null;
  const candidates = stageTasks(ledger, exec);
  // Tier one: released work, oldest first.
  let best: TaskRecord | null = null;
  for (const t of candidates) {
    if (t.released && fillable(t, node.nodeId) && (!best || t.createdAt < best.createdAt)) best = t;
  }
  if (best) return { task: best, speculative: false };
  // Tier two: pending work in stage order (the plan task comes first by construction).
  for (const t of candidates) {
    if (!t.released && fillable(t, node.nodeId)) return { task: t, speculative: false };
  }
  // Tier three: overdue attempts get a twin.
  for (const t of candidates) {
    if (speculatable(t, node.nodeId, now)) return { task: t, speculative: true };
  }
  return null;
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

/** Give every node with a free slot its next task (design §6.3). Deterministic: nodes by id. */
export function fill(ledger: Ledger, now: number): Effect[] {
  const effects: Effect[] = [];
  const exec = ledger.running ? ledger.executions.get(ledger.running) : undefined;
  if (!exec) return effects;
  const program = ledger.programs.get(exec.bundle);
  if (!program) return effects;
  const nodes = [...ledger.nodes.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId, "en"));
  // Round-robin: every node gets one task per round, so work spreads before any node fills up.
  for (let round = 0; round < LIMITS.maxInFlight; round++) {
    for (const node of nodes) {
      if (node.commanded === "freeze" || node.inFlight.length >= LIMITS.maxInFlight) continue;
      const pick = pickTask(ledger, node, now);
      if (!pick) continue;
      effects.push(
        ...assignTask(ledger, exec, program.module, node, pick.task, pick.speculative, now),
      );
    }
  }
  return effects;
}

function assignTask(
  ledger: Ledger,
  exec: ExecutionRecord,
  module: string,
  node: NodeRecord,
  task: TaskRecord,
  speculative: boolean,
  now: number,
): Effect[] {
  const attempt = task.attempts.length + 1;
  const deadline = deadlineMs(ledger, exec);
  task.attempts.push({
    attempt,
    nodeId: node.nodeId,
    assignedAt: now,
    deadlineAt: now + deadline,
    speculative,
    outcome: "running",
  });
  if (task.status === "pending") {
    task.status = "assigned";
    exec.counters.pending = Math.max(0, exec.counters.pending - 1);
    exec.counters.assigned += 1;
  }
  node.inFlight.push(task.taskId);
  if (speculative) exec.counters.speculated += 1;
  const msg: Assign = {
    t: "assign",
    v: PROTOCOL_VERSION,
    gen: ledger.meta.generation,
    taskId: task.taskId,
    attempt,
    executionId: exec.executionId,
    program: module,
    kind: task.kind,
    stage: Math.max(0, task.stage),
    index: task.index,
    count: task.kind === "plan" ? 1 : exec.stageTaskIds.length,
    input: toBase64(task.input),
    fsRoot: exec.root,
    deadlineMs: deadline,
    limits: ledger.config.taskLimits,
  };
  const effects: Effect[] = [{ kind: "send", connId: node.connId, msg }];
  effects.push(
    ...broadcast(
      ledger,
      speculative
        ? { t: "taskSpeculated", taskId: task.taskId, nodeId: node.nodeId }
        : { t: "taskAssigned", taskId: task.taskId, nodeId: node.nodeId, attempt },
    ),
  );
  return effects;
}

/** A node is gone: every open attempt it held is released (design §6.4). */
export function releaseNode(ledger: Ledger, node: NodeRecord): Effect[] {
  const effects: Effect[] = [];
  for (const taskId of node.inFlight) {
    const task = ledger.tasks.get(taskId);
    if (!task) continue;
    for (const a of task.attempts)
      if (a.nodeId === node.nodeId && a.outcome === "running") a.outcome = "released";
    if (
      task.status === "assigned" &&
      runningAttempts(task) === 0 &&
      currentRoundResults(task) === 0
    ) {
      task.status = "pending";
      task.released = true;
      const exec = ledger.executions.get(task.executionId);
      if (exec) {
        exec.counters.assigned = Math.max(0, exec.counters.assigned - 1);
        exec.counters.pending += 1;
        exec.counters.reassigned += 1;
      }
      effects.push(...broadcast(ledger, { t: "taskReassigned", taskId, fromNode: node.nodeId }));
    }
  }
  node.inFlight = [];
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

/** Fast or slow against the cluster median of compute time; throttled is decided by visibility. */
export function relabelHealth(ledger: Ledger): Effect[] {
  const effects: Effect[] = [];
  const samples = [...ledger.nodes.values()]
    .map((n) => n.ewmaMs)
    .filter((v): v is number => v !== null);
  if (samples.length === 0) return effects;
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  for (const node of ledger.nodes.values()) {
    if (!node.visible || node.ewmaMs === null) continue;
    const next: Health =
      node.ewmaMs > 2 * median && node.ewmaMs > ledger.config.deadlineFloorMs / 4 ? "slow" : "fast";
    if (next !== node.health) {
      node.health = next;
      effects.push(...broadcast(ledger, { t: "nodeHealth", nodeId: node.nodeId, health: next }));
    }
  }
  return effects;
}
