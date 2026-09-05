import type { Ledger } from "./ledger.ts";
import { KEEP_ENDED_EXECUTIONS, KEEP_ENDED_TASKS } from "./policy.ts";
import { dropUnreferencedRetired } from "./programs.ts";

/**
 * Keep the ledger small (design §9.4): ended executions beyond the most recent `keep` are dropped
 * outright, and the tasks of ended executions beyond the most recent `keepTasks` are dropped while
 * the record stays — a record is a few hundred bytes, a frame's tasks are hundreds of kilobytes.
 * Results live in the store by hash and a continuation copies what it inherits at enqueue, so
 * nothing live points at what is pruned. Returns the ids of the records dropped.
 */
export function pruneExecutions(
  ledger: Ledger,
  keep = KEEP_ENDED_EXECUTIONS,
  keepTasks = KEEP_ENDED_TASKS,
): string[] {
  const ended = [...ledger.executions.values()]
    .filter((e) => e.status === "done" || e.status === "failed" || e.status === "cancelled")
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  const dropRecords = ended.slice(keep).map((e) => e.executionId);
  // Whose tasks still exist? The first task tells; once it is gone the rest went with it, so an
  // already-pruned execution costs nothing on later ticks.
  const dropTasks = new Set(
    ended
      .slice(keepTasks)
      .filter((e) => {
        const probe = e.planTaskId ?? e.stageTaskIds[0];
        return probe !== undefined && ledger.tasks.has(probe);
      })
      .map((e) => e.executionId),
  );
  if (dropTasks.size > 0) {
    for (const [taskId, task] of ledger.tasks) {
      if (dropTasks.has(task.executionId)) ledger.tasks.delete(taskId);
    }
  }
  // The file map goes with the tasks: a frame's entries of hash and size, 32 frames deep, were
  // most of the deployed snapshot. The root hash stays, and inheritance reads the map back from
  // the root's manifest blob. Judged on its own, not with the task probe: an adopted ledger whose
  // tasks went before this rule existed still has the maps to lose.
  for (const e of ended.slice(keepTasks)) {
    if (Object.keys(e.files).length > 0) e.files = {};
  }
  for (const id of dropRecords) ledger.executions.delete(id);
  dropUnreferencedRetired(ledger);
  return dropRecords;
}
