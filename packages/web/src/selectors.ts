// Views over the cluster state: what the page draws is derived here, never stored twice.
import {
  type Activity,
  CHART_WINDOW_MS,
  type ClusterState,
  FLASH_MS,
  isRunningPhase,
  type ProgramInfo,
  type StageState,
  type TaskColor,
  type TaskState,
  THROUGHPUT_WINDOW_MS,
} from "./cluster-state.ts";

/** Whether an execution is on the stage right now. */
export function isRunning(state: ClusterState): boolean {
  return state.execution !== null && isRunningPhase(state.execution.phase);
}

/** The automatic loop's state, in the order a visitor needs to know it. */
export type LoopState = "paused" | "held" | "yielded" | "running";

export function loopState(state: ClusterState): LoopState {
  const m = state.machine;
  if (m?.paused) return "paused";
  if (m?.stopped) return "held";
  if (m?.yielded) return "yielded";
  return "running";
}

/**
 * The header's one slot always means "what you can do to the machine right now": Resume while an
 * editor tab holds it, Stop while anything runs (the loop's frame or a person's launch), Start
 * when nothing runs and the loop is held or has yielded, and Stop again when the loop is free —
 * to hold it before its next frame.
 */
export type HeaderSlot = "stop" | "start" | "resume";

export function headerSlot(state: ClusterState): HeaderSlot {
  const loop = loopState(state);
  if (loop === "paused") return "resume";
  if (isRunning(state)) return "stop";
  if (loop === "held" || loop === "yielded") return "start";
  return "stop";
}

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
      return task.contested ? "mismatch" : task.released ? "released" : "pending";
  }
}

export function isFlashing(at: number | null, now: number): boolean {
  return at !== null && now - at < FLASH_MS;
}

/** Tasks per second over the window, from arrival times. */
export function throughput(state: ClusterState, now: number): number {
  const floor = now - THROUGHPUT_WINDOW_MS;
  return state.doneAt.filter((t) => t > floor).length / (THROUGHPUT_WINDOW_MS / 1000);
}

/**
 * Tasks done per second over the chart window, oldest bucket first; the last bucket is the
 * current second. Sixty numbers for the default window.
 */
export function throughputSeries(
  state: ClusterState,
  now: number,
  seconds = CHART_WINDOW_MS / 1000,
): number[] {
  const buckets = new Array<number>(seconds).fill(0);
  for (const t of state.doneLog) {
    const i = seconds - 1 - Math.floor((now - t) / 1000);
    if (i >= 0 && i < seconds) buckets[i] = (buckets[i] as number) + 1;
  }
  return buckets;
}

/** Milliseconds until the reconnect a rotation announced, floored at zero; null when none is on. */
export function rotationCountdown(rotation: ClusterState["rotation"], now: number): number | null {
  return rotation ? Math.max(0, rotation.at + rotation.reconnectAfterMs - now) : null;
}

/** What stands between the visitor and a plainly live machine, or null when nothing does. */
export type MachineBanner =
  | { kind: "rotating"; next: number; msLeft: number }
  | { kind: "sleeping"; reason: string }
  | { kind: "asleep"; reason: string | null };

export function machineBanner(state: ClusterState, now: number): MachineBanner | null {
  const msLeft = rotationCountdown(state.rotation, now);
  if (state.rotation && msLeft !== null)
    return { kind: "rotating", next: state.rotation.next, msLeft };
  if (state.sleeping) return { kind: "sleeping", reason: state.sleeping };
  if (state.machine && !state.machine.awake)
    return { kind: "asleep", reason: state.machine.reason };
  return null;
}

/** A settled task's line in the ledger: what the control plane holds about its output. */
export interface LedgerRow {
  taskId: string;
  index: number;
  output: string;
  /** Known for placed tiles (w × h × 4 bytes of RGBA); null until a manifest names the size. */
  size: number | null;
  nodeId: string | null;
  computeMs: number | null;
  verified: boolean;
}

/** The most recently settled tasks of the current stage, newest first. */
export function ledgerRows(state: ClusterState, limit = 8): LedgerRow[] {
  const rows: Array<LedgerRow & { at: number }> = [];
  for (const t of state.tasks.values()) {
    if (t.status !== "done" || !t.output) continue;
    const winner = [...t.history].reverse().find((a) => a.outcome === "done");
    rows.push({
      taskId: t.taskId,
      index: t.index,
      output: t.output,
      size: t.place ? t.place.w * t.place.h * 4 : null,
      nodeId: winner?.nodeId ?? null,
      computeMs: t.computeMs,
      verified: t.verified,
      at: t.settledAt ?? -1,
    });
  }
  rows.sort((a, b) => b.at - a.at || b.index - a.index);
  return rows.slice(0, limit).map(({ at: _at, ...row }) => row);
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

/** Programs sorted by name, for the panel. */
export function programList(state: ClusterState): ProgramInfo[] {
  return [...state.programs.values()].sort((a, b) => a.name.localeCompare(b.name, "en"));
}

/**
 * The stage strip's rows: every stage seen so far, plus the planning step the execution is in
 * when no stage is running (a plan task ahead of the next stage, or the very first one).
 */
export type StripEntry =
  | { kind: "stage"; stage: StageState; current: boolean }
  | { kind: "plan"; stage: number; holders: string[] };

export function stageStrip(state: ClusterState): StripEntry[] {
  const exec = state.execution;
  if (!exec) return [];
  const entries: StripEntry[] = exec.stages.map((s, i) => ({
    kind: "stage",
    stage: s,
    current: i === exec.stage && exec.phase === "running",
  }));
  if (exec.phase === "planning" || exec.phase === "folding") {
    const plan = planTask(state);
    entries.push({
      kind: "plan",
      stage: exec.phase === "folding" ? exec.stage + 1 : exec.stage,
      holders: plan?.holders ?? [],
    });
  }
  return entries;
}

/** The newest control line of the last minute: what a person just did must stay readable. */
export function latestControl(state: ClusterState, now: number): Activity | null {
  for (let i = state.activity.length - 1; i >= 0; i--) {
    const a = state.activity[i];
    if (!a) break;
    if (now - a.at > 60_000) return null;
    if (a.kind === "control") return a;
  }
  return null;
}

/**
 * The dashboard's activity snippet: the last fourteen lines, with the latest control line of the
 * last minute kept in place — a kill half is followed within a second by more reassignments and
 * departures than the snippet holds, and the line saying what the click did must not vanish.
 * A panel tab (`all`) shows everything.
 */
export function visibleActivity(state: ClusterState, now: number, all = false): Activity[] {
  if (all) return [...state.activity];
  const recent = state.activity.slice(-14);
  const control = latestControl(state, now);
  if (control && !recent.includes(control)) recent[0] = control;
  return recent;
}
