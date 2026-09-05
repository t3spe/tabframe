import { canonicalStringify, RELEASED, type Result } from "@tabframe/protocol";
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
import {
  COMPUTE_MS_REPORT_CAP,
  MAX_CONTESTED_ROUNDS,
  RELEASES_PER_TASK_CAP,
  RESULTS_PER_TASK_CAP,
} from "./policy.ts";
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
  // A report for an attempt this node never held is still evidence (D7: a late duplicate settles,
  // verifies, or contests; the tests and the design lean on it), but it cannot *fail* a task
  // (WP8.1): without this, any connected node could end any execution with one error message.
  const known = task?.attempts.find((a) => a.attempt === msg.attempt && a.nodeId === node.nodeId);
  // (WP8.2) An unknown attempt may verify or contest a *settled* task (D7's late duplicate); it
  // can neither settle an open task nor fail one: any visitor holds the public token and task ids
  // are sequential, so an open task must only be closed by a node that was given it.
  if (task && !known && (task.status !== "done" || !task.accepted || msg.error !== undefined))
    return { effects, settlement: { kind: "none" } };
  // Compute time is what the node says, within a bound (WP8.1): the attempt's own deadline window
  // or ten minutes, whichever is longer, so a report cannot spend the execution's budget at will.
  const bound = Math.max(COMPUTE_MS_REPORT_CAP, known ? known.deadlineAt - known.assignedAt : 0);
  if (msg.computeMs > bound) msg = { ...msg, computeMs: bound };
  if (task) msg = checkTileSize(ledger, task, msg);
  if (attempt) node.inFlight = node.inFlight.filter((id) => id !== msg.taskId);
  if (msg.error === RELEASED) {
    // The node gave up at its own deadline: the attempt is released, the task is not judged — but
    // the time it held the task is charged to the execution (WP8.2: a program that spins for ever
    // used to be free), and a task released too many times is a program fault, not bad luck.
    // Only the running attempt can be released (WP8.3): a replayed release charged the budget again
    // and again, so a single node could fail any execution with a handful of frames.
    if (!attempt) return { effects, settlement: { kind: "none" } };
    attempt.outcome = "released";
    const exec = task ? ledger.executions.get(task.executionId) : undefined;
    if (exec?.status === "running")
      exec.computeMsUsed += Math.max(0, Math.min(now, attempt.deadlineAt) - attempt.assignedAt);
    if (task && exec?.status === "running") {
      const released = task.attempts.filter((a) => a.outcome === "released").length;
      if (released >= RELEASES_PER_TASK_CAP && task.status !== "done" && task.status !== "failed") {
        effects.push(...cancelOthers(ledger, task, null));
        task.status = "failed";
        task.failure = `released ${released} times: the task never finishes within its deadline`;
        exec.counters.failed += 1;
        effects.push(
          ...broadcast(ledger, { t: "taskFailed", taskId: task.taskId, reason: task.failure }),
        );
        return { effects, settlement: { kind: "failed", task, reason: task.failure } };
      }
    }
    if (task) effects.push(...releaseIfOrphaned(ledger, task, node.nodeId));
    return { effects, settlement: { kind: "none" } };
  }
  if (!task) return { effects, settlement: { kind: "none" } };
  if (attempt) attempt.outcome = msg.error === undefined ? "result" : "error";
  const exec = ledger.executions.get(task.executionId);
  if (exec?.status !== "running") return { effects, settlement: { kind: "none" } };

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
  // Bounded evidence (WP8.1): every record travels in snapshots and handovers.
  if (task.results.length >= RESULTS_PER_TASK_CAP) return { effects, settlement: { kind: "none" } };
  // The budget, the deadline samples, and the node's speed are charged once per attempt the ledger
  // handed out (WP8.3), after the duplicate checks: a replayed report used to spend the execution's
  // budget every time it arrived and feed the deadline model with copies.
  if (attempt) {
    node.tasksDone += 1;
    node.lastTaskMs = msg.computeMs;
    node.ewmaMs =
      node.ewmaMs === null ? msg.computeMs : Math.round(node.ewmaMs * 0.7 + msg.computeMs * 0.3);
    if (task.kind === "run") {
      exec.computeSamples.push(msg.computeMs);
      if (exec.computeSamples.length > 50) exec.computeSamples.shift();
    }
    exec.computeMsUsed += msg.computeMs;
  }

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
    const accepted = accept(ledger, exec, task, chosen, node.nodeId, now);
    if (task.requiredAgreement > 1 && task.status === "done") {
      // Agreement by recompute (redundancy on): the node that completed it verified the other.
      // Without this the toggle's own counter never moved — a twin that agrees *after* a task is
      // done was counted, the pair that settles it together was not (found by the WP4.4 demo).
      exec.counters.verified += 1;
      accepted.push(
        ...broadcast(ledger, { t: "taskVerified", taskId: task.taskId, nodeId: node.nodeId }),
      );
    }
    return { effects: [...effects, ...accepted], settlement: settlementFor(task, chosen) };
  }
  // Waiting for the twin (redundancy on). Nothing to announce yet.
  return { effects, settlement: { kind: "none" } };
}

/**
 * Settle a task on the result it already holds (WP8.1): when redundancy is turned off, a task that
 * waited for a twin settles on the one report it has.
 */
export function settleExisting(
  ledger: Ledger,
  task: TaskRecord,
  now: number,
): { effects: Effect[]; settlement: Settlement } {
  const exec = ledger.executions.get(task.executionId);
  if (exec?.status !== "running" || task.status === "done" || task.status === "failed")
    return { effects: [], settlement: { kind: "none" } };
  const round = task.results.filter((r) => r.round === task.contestedRounds);
  const chosen = round[0];
  if (!chosen || round.length < task.requiredAgreement)
    return { effects: [], settlement: { kind: "none" } };
  const effects = accept(ledger, exec, task, chosen, chosen.nodeId, now);
  return { effects, settlement: settlementFor(task, chosen) };
}

/** A tile is RGBA of its placed size (design §5.2); anything else is a program fault. */
function checkTileSize(ledger: Ledger, task: TaskRecord, msg: Result): Result {
  if (msg.error !== undefined || !task.place) return msg;
  const exec = ledger.executions.get(task.executionId);
  if (exec?.manifest.view !== "tiles") return msg;
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
