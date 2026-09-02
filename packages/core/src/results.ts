import { canonicalStringify, PROTOCOL_VERSION, type Result } from "@tabframe/protocol";
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
  // The result names its attempt. Only that attempt closes: a stale report for an attempt that was
  // cancelled must not close a newer attempt of the same task on the same node, or the node ends
  // up holding work the control plane thinks is finished. It still counts as evidence below.
  const attempt = task?.attempts.find(
    (a) => a.attempt === msg.attempt && a.nodeId === node.nodeId && a.outcome === "running",
  );
  if (attempt) node.inFlight = node.inFlight.filter((id) => id !== msg.taskId);
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

  // One report per node per round: a repeat of what the node already said adds no evidence
  // (agreement means two nodes, D7); a node that contradicts itself goes through the mismatch path.
  const earlier = task.results.find(
    (r) => r.round === task.contestedRounds && r.nodeId === node.nodeId,
  );
  if (earlier && earlier.identity === record.identity)
    return { effects, settlement: { kind: "none" } };

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
    if (sealed(exec, task)) {
      // The stage is folded (or the plan consumed): the result is committed. The disagreement is
      // announced and counted, but nothing is withdrawn.
      exec.counters.mismatched += 1;
      effects.push(
        ...broadcast(ledger, { t: "taskMismatch", taskId: task.taskId, nodeId: node.nodeId }),
      );
      return { effects, settlement: { kind: "none" } };
    }
    effects.push(...contest(ledger, exec, task, node.nodeId));
    const settlement = settleContested(ledger, exec, task, now, effects);
    return { effects, settlement };
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

/**
 * A done task whose result the execution has already built on: a plan task once its spec was
 * fetched, a run task once its stage was folded. Retracting it would unwind a manifest that
 * later stages may read, so a late mismatch there is recorded, not acted on.
 */
function sealed(exec: ExecutionRecord, task: TaskRecord): boolean {
  return task.kind === "plan" || task.stage <= (exec.sealedStage ?? -1);
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

/** Rounds after which a tied vote is broken by report order rather than by another round. */
const MAX_CONTESTED_ROUNDS = 4;

/**
 * After the second contested round, the identity reported by the most nodes wins (D7). Votes are
 * nodes, not reports: a node that keeps reporting the same bytes round after round counts once.
 * A tie is not a majority: the task goes round once more (to nodes that have not reported, when
 * any is free) until a majority exists or the round cap is reached.
 */
function settleContested(
  ledger: Ledger,
  exec: ExecutionRecord,
  task: TaskRecord,
  now: number,
  effects: Effect[],
): Settlement {
  if (task.contestedRounds < 2) return { kind: "contested", task };
  const votes = new Map<string, { nodes: Set<string>; first: ResultRecord }>();
  for (const r of task.results) {
    const v = votes.get(r.identity);
    if (v) v.nodes.add(r.nodeId);
    else votes.set(r.identity, { nodes: new Set([r.nodeId]), first: r });
  }
  let winner: ResultRecord | null = null;
  let best = -1;
  let tied = false;
  for (const { nodes, first } of votes.values()) {
    if (nodes.size > best) {
      best = nodes.size;
      winner = first;
      tied = false;
    } else if (nodes.size === best) {
      tied = true;
    }
  }
  if (!winner) return { kind: "contested", task };
  if (tied && task.contestedRounds < MAX_CONTESTED_ROUNDS) return { kind: "contested", task };
  task.resolvedByVote = true;
  exec.counters.pending = Math.max(0, exec.counters.pending - 1);
  task.status = "assigned"; // accept() expects an open task
  exec.counters.assigned += 1;
  effects.push(...accept(ledger, exec, task, winner, winner.nodeId, now));
  return settlementFor(task, winner);
}

export { PROTOCOL_VERSION, runningAttempts };
