// Snapshot pages (design §8.3): page 0 carries the cluster; every page carries task rows, packed
// by bytes as well as by row count, because a full frame of done tiles with two holders each does
// not fit 256 rows under the message cap.
import {
  byteLength,
  canonicalStringify,
  LIMITS,
  type MachineView,
  PROTOCOL_VERSION,
  type ProgramView,
  type Snapshot,
  type TaskView,
} from "@tabframe/protocol";
import type { Effect } from "./events.ts";
import { executionTasks, latestExecution, runningExecution } from "./execution.ts";
import {
  executionView,
  type Ledger,
  nodeView,
  type ProgramRecord,
  queueEntry,
  taskView,
} from "./ledger.ts";
import { SNAPSHOT_PAGE_BUDGET } from "./policy.ts";

export function programView(p: ProgramRecord): ProgramView {
  return {
    bundle: p.bundle,
    name: p.manifest.name,
    view: p.manifest.view,
    description: p.manifest.description ?? null,
    defaultParams: p.manifest.defaultParams,
    addedAt: p.addedAt,
    source: p.manifest.source ?? null,
  };
}

/** The snapshot a fresh subscriber gets, as one send per page. */
export function snapshotPages(ledger: Ledger, connId: string, now: number): Effect[] {
  // Nothing running: the snapshot shows the execution that ended last, so a visitor arriving
  // during the hold after a person's launch — or a dashboard resubscribing — sees the result on
  // the stage rather than "idle". Its tasks are still in the ledger for the two most recent frames.
  const exec = runningExecution(ledger) ?? latestExecution(ledger, (e) => e.endedAt !== null);
  const tasks = exec ? executionTasks(ledger, exec.executionId).map(taskView) : [];
  const machine: MachineView = {
    awake: ledger.meta.awake,
    reason: ledger.meta.sleepReason,
    redundancy: ledger.meta.redundancy,
    stopped: ledger.meta.loopStopped,
    paused: ledger.session.pausedBy !== null,
    yielded: ledger.meta.loopYielded,
    nextRotationAt: null,
    uptimeMs: Math.max(0, now - ledger.meta.startedAt),
  };
  const cluster = {
    nodes: [...ledger.nodes.values()].map(nodeView),
    programs: [...ledger.programs.values()].filter((p) => !p.retired).map(programView),
    execution: exec ? executionView(exec) : null,
    queue: ledger.queue
      .map((id) => ledger.executions.get(id))
      .filter((e) => e !== undefined)
      .map(queueEntry),
    machine,
  };
  // Page 0 must fit one frame whatever the programs carry: sixty-four programs with four kilobytes
  // of defaults each would not, so the defaults are the first thing to go — the editor reads the
  // manifest from the store anyway — and a subscribe degrades instead of closing.
  let clusterBytes = byteLength(canonicalStringify(cluster));
  if (clusterBytes > SNAPSHOT_PAGE_BUDGET) {
    cluster.programs = cluster.programs.map((p) => ({ ...p, defaultParams: {} }));
    clusterBytes = byteLength(canonicalStringify(cluster));
  }
  // The page split is memoised per (generation, seq): a connect-subscribe-close loop costs one
  // serialisation per change rather than one per subscribe.
  const memo = ledger.session.pageMemo;
  let pages: TaskView[][];
  if (memo && memo.gen === ledger.meta.generation && memo.seq === ledger.meta.seq) {
    pages = memo.pages;
  } else {
    pages = [];
    let current: TaskView[] = [];
    let used = clusterBytes;
    for (const view of tasks) {
      const size = byteLength(canonicalStringify(view)) + 1;
      if (
        current.length > 0 &&
        (current.length >= LIMITS.snapshotPageTasks || used + size > SNAPSHOT_PAGE_BUDGET)
      ) {
        pages.push(current);
        current = [];
        used = 0;
      }
      current.push(view);
      used += size;
    }
    pages.push(current);
    ledger.session.pageMemo = { gen: ledger.meta.generation, seq: ledger.meta.seq, pages };
  }
  const effects: Effect[] = [];
  for (let page = 0; page < pages.length; page++) {
    const base: Snapshot = {
      t: "snapshot",
      v: PROTOCOL_VERSION,
      gen: ledger.meta.generation,
      seq: ledger.meta.seq,
      page,
      pages: pages.length,
      tasks: pages[page] ?? [],
      at: now,
    };
    effects.push({ kind: "send", connId, msg: page === 0 ? { ...base, ...cluster } : base });
  }
  return effects;
}
