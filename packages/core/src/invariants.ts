import type { Ledger } from "./ledger.ts";

/**
 * The invariants of design §6.10 as a checker the tests and the simulation call after every event.
 * Returns a list of violations; an empty list is the only acceptable answer.
 */
export function checkInvariants(ledger: Ledger): string[] {
  const v: string[] = [];
  for (const [connId, nodeId] of ledger.nodeByConn) {
    const n = ledger.nodes.get(nodeId);
    if (!n) v.push(`nodeByConn ${connId} → missing node ${nodeId}`);
    else if (n.connId !== connId) v.push(`node ${nodeId} conn mismatch`);
    if (!ledger.conns.has(connId)) v.push(`node ${nodeId} has no connection state`);
  }
  for (const n of ledger.nodes.values()) {
    if (ledger.nodeByConn.get(n.connId) !== n.nodeId)
      v.push(`node ${n.nodeId} not indexed by its connection`);
    for (const taskId of n.inFlight) {
      const t = ledger.tasks.get(taskId);
      if (!t) v.push(`node ${n.nodeId} in-flight unknown task ${taskId}`);
      else if (!t.attempts.some((a) => a.nodeId === n.nodeId && a.outcome === "running"))
        v.push(`node ${n.nodeId} in-flight ${taskId} without a running attempt`);
      else if (t.executionId !== ledger.running)
        v.push(`node ${n.nodeId} holds ${taskId} of ${t.executionId}, which is not running`);
    }
  }
  for (const t of ledger.tasks.values()) {
    const running = t.attempts.filter((a) => a.outcome === "running");
    if (running.length > 2) v.push(`task ${t.taskId} has ${running.length} open attempts`);
    for (const a of running) {
      const n = ledger.nodes.get(a.nodeId);
      if (!n) v.push(`task ${t.taskId} assigned to gone node ${a.nodeId}`);
      else if (!n.inFlight.includes(t.taskId))
        v.push(`task ${t.taskId} running on ${a.nodeId} but not in its in-flight list`);
    }
    if (t.status === "done" && !t.accepted)
      v.push(`task ${t.taskId} done without an accepted result`);
    if (
      t.status === "done" &&
      t.accepted &&
      !t.results.some((r) => r.identity === t.accepted?.identity)
    ) {
      v.push(`task ${t.taskId} accepted result is not one of its results`);
    }
    if ((t.status === "done" || t.status === "failed") && running.length > 0)
      v.push(`task ${t.taskId} settled with open attempts`);
    if (t.status === "pending" && running.length > 0)
      v.push(`task ${t.taskId} pending with open attempts`);
    if (
      t.status === "assigned" &&
      running.length === 0 &&
      t.results.filter((r) => r.round === t.contestedRounds).length === 0
    )
      v.push(`task ${t.taskId} assigned with nothing running`);
  }
  // A core's node link names a live node of that core's own MicroVM (design §6.8).
  for (const c of ledger.cores.values()) {
    if (c.nodeId === null) continue;
    const n = ledger.nodes.get(c.nodeId);
    if (!n) v.push(`core ${c.microvmId} links to gone node ${c.nodeId}`);
    else if (n.hostId !== `core-${c.microvmId}`)
      v.push(`core ${c.microvmId} links to ${c.nodeId}, whose host is ${n.hostId}`);
  }
  if (ledger.running) {
    const e = ledger.executions.get(ledger.running);
    if (!e) v.push("running points at a missing execution");
    else if (e.status !== "running")
      v.push(`running execution ${e.executionId} has status ${e.status}`);
    if (ledger.queue.includes(ledger.running)) v.push("running execution is also queued");
  }
  const runningCount = [...ledger.executions.values()].filter((e) => e.status === "running").length;
  if (runningCount > 1) v.push(`${runningCount} executions running at once`);
  if (new Set(ledger.queue).size !== ledger.queue.length) v.push("duplicate queue entries");
  for (const id of ledger.queue) {
    const e = ledger.executions.get(id);
    if (!e) v.push(`queued unknown execution ${id}`);
    else if (e.status !== "queued") v.push(`queued execution ${id} has status ${e.status}`);
  }
  // An ended execution leaves nothing open behind (design §6.10).
  for (const t of ledger.tasks.values()) {
    if (t.status !== "pending" && t.status !== "assigned") continue;
    const e = ledger.executions.get(t.executionId);
    if (e && e.status !== "running" && e.status !== "queued")
      v.push(`execution ${e.executionId} is ${e.status} while ${t.taskId} is ${t.status}`);
  }
  // The running execution's counters are what its tasks say: the open ones live in the current
  // stage, the done ones accumulate over every stage.
  for (const e of ledger.executions.values()) {
    if (e.status !== "running") continue;
    if (e.sealedStage > e.stage)
      v.push(`execution ${e.executionId} sealed stage ${e.sealedStage} past stage ${e.stage}`);
    const current = e.planTaskId ? [e.planTaskId, ...e.stageTaskIds] : e.stageTaskIds;
    for (const id of current) {
      if (!ledger.tasks.has(id)) v.push(`execution ${e.executionId} references missing task ${id}`);
    }
    const counts = { pending: 0, assigned: 0, done: 0, failed: 0 };
    for (const t of ledger.tasks.values())
      if (t.executionId === e.executionId) counts[t.status] += 1;
    for (const key of ["pending", "assigned", "done", "failed"] as const) {
      if (counts[key] !== e.counters[key])
        v.push(`execution ${e.executionId} ${key} counter ${e.counters[key]} vs ${counts[key]}`);
    }
  }
  return v;
}
