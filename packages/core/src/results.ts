import { canonicalStringify, PROTOCOL_VERSION, RELEASED, type Result } from "@tabframe/protocol";
import type { Effect } from "./events.ts";
import type {
  ExecutionRecord,
  Ledger,
  NodeRecord,
  ResultRecord,
  TaskRecord,
  WriteRecord,
} from "./ledger.ts";
import { broadcast } from "./observers.ts";
import { cancelOthers, runningAttempts } from "./scheduler.ts";

/** Equal identities mean identical output bytes and identical written files (design §5.4). */
export function resultIdentity(output: string, writes: WriteRecord[]): string {
  const sorted = [...writes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return canonicalStringify({ o: output, w: sorted.map((w) => [w.path, w.hash, w.size]) });
}

export type Settlement =
  | { kind: "none" }
  | { kind: "done"; task: TaskRecord; result: ResultRecord }
  | { kind: "failed"; task: TaskRecord; reason: string }
  | { kind: "contested"; task: TaskRecord };

/**
 * A result arrived (design §6.5, D7). Updates node statistics, records the result, and settles the
 * task when the required agreement is reached; disagreement discards the round and recomputes,
 * and a third disagreement is resolved by majority. Returns the settlement so the caller can
 * advance the stage.
 */
export function onResult(
  ledger: Ledger,
  node: NodeRecord,
  msg: Result,
  now: number,
): { effects: Effect[]; settlement: Settlement } {
  const effects: Effect[] = [];
  const task = ledger.tasks.get(msg.taskId);
  const attempt = task?.attempts.find((a) => a.nodeId === node.nodeId && a.outcome === "running");
  if (task) msg = checkTileSize(ledger, task, msg);
  // Bookkeeping on the node regardless of what the task says.
  node.inFlight = node.inFlight.filter((id) => id !== msg.taskId);
  if (msg.error === RELEASED) {
    // The node gave up at its own deadline: the attempt is released, the task is not judged.
    if (attempt) attempt.outcome = "released";
    if (task) effects.push(...releaseIfOrphaned(ledger, task, node.nodeId));
    return { effects, settlement: { kind: "none" } };
  }
  node.tasksDone += 1;
  node.lastTaskMs = msg.computeMs;
  node.ewmaMs =
    node.ewmaMs === null ? msg.computeMs : Math.round(node.ewmaMs * 0.7 + msg.computeMs * 0.3);
  if (!task) return { effects, settlement: { kind: "none" } };
  if (attempt) attempt.outcome = msg.error === undefined ? "result" : "error";
  const exec = ledger.executions.get(task.executionId);
  if (!exec || exec.status !== "running") return { effects, settlement: { kind: "none" } };
  if (task.kind === "run") {
    exec.computeSamples.push(msg.computeMs);
    if (exec.computeSamples.length > 50) exec.computeSamples.shift();
  }
  exec.computeMsUsed += msg.computeMs;

  const record: ResultRecord =
    msg.error === undefined
      ? {
          identity: resultIdentity(msg.output ?? "", msg.writes),
          output: msg.output ?? "",
          outputSize: msg.outputSize ?? 0,
          writes: msg.writes,
          log: msg.log,
          nodeId: node.nodeId,
          attempt: msg.attempt,
          computeMs: msg.computeMs,
          round: task.contestedRounds,
        }
      : {
          identity: `error:${msg.error}`,
          output: "",
          outputSize: 0,
          writes: [],
          log: msg.log,
          nodeId: node.nodeId,
          attempt: msg.attempt,
          computeMs: msg.computeMs,
          round: task.contestedRounds,
        };

  // A result for a settled task is a duplicate: verify or contest it.
  if (task.status === "done" && task.accepted) {
    if (record.identity === task.accepted.identity) {
      exec.counters.verified += 1;
      effects.push(
        ...broadcast(ledger, { t: "taskVerified", taskId: task.taskId, nodeId: node.nodeId }),
      );
      return { effects, settlement: { kind: "none" } };
    }
    task.results.push(record);
    return {
      effects: [...effects, ...contest(ledger, exec, task, node.nodeId)],
      settlement: settleContested(ledger, exec, task, now, effects),
    };
  }
  if (task.status === "failed") return { effects, settlement: { kind: "none" } };

  task.results.push(record);
  const round = task.results.filter((r) => r.round === task.contestedRounds);
  const identities = new Set(round.map((r) => r.identity));
  if (identities.size > 1) {
    effects.push(...contest(ledger, exec, task, node.nodeId));
    return { effects, settlement: settleContested(ledger, exec, task, now, effects) };
  }
  if (round.length >= task.requiredAgreement) {
    const chosen = round[0] as ResultRecord;
    return {
      effects: [...effects, ...accept(ledger, exec, task, chosen, node.nodeId, now)],
      settlement: settlementFor(task, chosen),
    };
  }
  // Waiting for the twin (redundancy on). Nothing to announce yet.
  return { effects, settlement: { kind: "none" } };
}

/** A tile is RGBA of its placed size (design §5.2); anything else is a program fault. */
function checkTileSize(ledger: Ledger, task: TaskRecord, msg: Result): Result {
  if (msg.error !== undefined || !task.place) return msg;
  const exec = ledger.executions.get(task.executionId);
  if (!exec || exec.manifest.view !== "tiles") return msg;
  const expected = task.place.w * task.place.h * 4;
  if (msg.outputSize === expected) return msg;
  const { output: _o, outputSize: _s, ...rest } = msg;
  return {
    ...rest,
    writes: [],
    error: `tile output is ${msg.outputSize ?? 0} bytes, expected ${expected} (RGBA ${task.place.w}×${task.place.h})`,
  };
}

/** With no attempt left running and nothing decided this round, the task goes back to the front. */
function releaseIfOrphaned(ledger: Ledger, task: TaskRecord, fromNode: string): Effect[] {
  if (task.status !== "assigned" || runningAttempts(task) > 0) return [];
  if (task.results.some((r) => r.round === task.contestedRounds)) return [];
  task.status = "pending";
  task.released = true;
  const exec = ledger.executions.get(task.executionId);
  if (exec) {
    exec.counters.assigned = Math.max(0, exec.counters.assigned - 1);
    exec.counters.pending += 1;
    exec.counters.reassigned += 1;
  }
  return broadcast(ledger, { t: "taskReassigned", taskId: task.taskId, fromNode });
}

function settlementFor(task: TaskRecord, result: ResultRecord): Settlement {
  if (task.status === "failed")
    return { kind: "failed", task, reason: task.failure ?? "program fault" };
  return { kind: "done", task, result };
}

/** Settle the task on this result: a trap fails it, anything else completes it (design §6.5). */
function accept(
  ledger: Ledger,
  exec: ExecutionRecord,
  task: TaskRecord,
  result: ResultRecord,
  byNode: string,
  now: number,
): Effect[] {
  const effects: Effect[] = [];
  effects.push(...cancelOthers(ledger, task, null));
  task.accepted = result;
  task.doneAt = now;
  if (task.status === "assigned") exec.counters.assigned = Math.max(0, exec.counters.assigned - 1);
  if (result.identity.startsWith("error:")) {
    task.status = "failed";
    task.failure = result.identity.slice(6);
    exec.counters.failed += 1;
    effects.push(
      ...broadcast(ledger, { t: "taskFailed", taskId: task.taskId, reason: task.failure }),
    );
    return effects;
  }
  task.status = "done";
  exec.counters.done += 1;
  effects.push(
    ...broadcast(ledger, {
      t: "taskDone",
      taskId: task.taskId,
      nodeId: byNode,
      output: result.output,
      place: task.place,
      computeMs: result.computeMs,
    }),
  );
  return effects;
}

/** Disagreement: discard the round, cancel open attempts, and send the task back to the front (D7). */
function contest(
  ledger: Ledger,
  exec: ExecutionRecord,
  task: TaskRecord,
  byNode: string,
): Effect[] {
  const effects: Effect[] = [];
  exec.counters.mismatched += 1;
  effects.push(...broadcast(ledger, { t: "taskMismatch", taskId: task.taskId, nodeId: byNode }));
  effects.push(...cancelOthers(ledger, task, null));
  if (task.status === "done") {
    // Retraction (toggle off): the painted tile is withdrawn and recomputed.
    exec.counters.done = Math.max(0, exec.counters.done - 1);
    task.accepted = null;
    task.doneAt = null;
  } else if (task.status === "assigned") {
    exec.counters.assigned = Math.max(0, exec.counters.assigned - 1);
  }
  task.contestedRounds += 1;
  task.status = "pending";
  task.released = true;
  exec.counters.pending += 1;
  return effects;
}

/** After the second contested round, the majority identity across every result wins (D7). */
function settleContested(
  ledger: Ledger,
  exec: ExecutionRecord,
  task: TaskRecord,
  now: number,
  effects: Effect[],
): Settlement {
  if (task.contestedRounds < 2) return { kind: "contested", task };
  const votes = new Map<string, { count: number; first: ResultRecord }>();
  for (const r of task.results) {
    const v = votes.get(r.identity);
    if (v) v.count += 1;
    else votes.set(r.identity, { count: 1, first: r });
  }
  let winner: ResultRecord | null = null;
  let best = -1;
  for (const { count, first } of votes.values()) {
    if (count > best) {
      best = count;
      winner = first;
    }
  }
  if (!winner) return { kind: "contested", task };
  task.resolvedByVote = true;
  exec.counters.pending = Math.max(0, exec.counters.pending - 1);
  task.status = "assigned"; // accept() expects an open task
  exec.counters.assigned += 1;
  effects.push(...accept(ledger, exec, task, winner, winner.nodeId, now));
  return settlementFor(task, winner);
}

export { PROTOCOL_VERSION, runningAttempts };
