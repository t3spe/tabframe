import {
  AbiError,
  canonicalStringify,
  decodeStageSpec,
  encodePlanInput,
  type FsManifest,
  PROTOCOL_VERSION,
  type ProgramManifest,
} from "@tabframe/protocol";
import type { Effect } from "./events.ts";
import {
  type ExecutionRecord,
  emptyCounters,
  executionView,
  type Ledger,
  type NodeRecord,
  queueEntry,
  type TaskRecord,
  taskView,
} from "./ledger.ts";
import { broadcast } from "./observers.ts";
import { cancelOthers, fill } from "./scheduler.ts";

const encoder = new TextEncoder();

export function addProgram(
  ledger: Ledger,
  bundle: string,
  module: string,
  manifest: ProgramManifest,
  files: FsManifest["files"],
  now: number,
): Effect[] {
  ledger.programs.set(bundle, { bundle, module, manifest, files, addedAt: now });
  return broadcast(ledger, { t: "programAdded", program: bundle, name: manifest.name });
}

export interface LaunchRequest {
  bundle: string;
  params: Record<string, unknown>;
  human: boolean;
  inherit: string | "latest" | null;
}

/** Queue an execution: human launches go ahead of automatic continuations (design §6.7). */
export function enqueue(
  ledger: Ledger,
  req: LaunchRequest,
  now: number,
): { effects: Effect[]; executionId: string | null; error?: string } {
  const program = ledger.programs.get(req.bundle);
  if (!program) return { effects: [], executionId: null, error: "unknown program" };
  // A `persist` program inherits the latest finished run of itself unless told otherwise (D5).
  const inherit = req.inherit ?? (program.manifest.persist ? "latest" : null);
  const inherited = resolveInherit(ledger, { ...req, inherit });
  if (req.inherit && !inherited)
    return { effects: [], executionId: null, error: "nothing to inherit" };
  const executionId = `e${++ledger.meta.executionCounter}`;
  const exec: ExecutionRecord = {
    executionId,
    bundle: req.bundle,
    manifest: program.manifest,
    params: req.params,
    human: req.human,
    status: "queued",
    queuedAt: now,
    startedAt: null,
    endedAt: null,
    stage: -1,
    stageName: "",
    canvas: null,
    stageTaskIds: [],
    planTaskId: null,
    // The filesystem starts from the bundle's own files, overlaid on whatever it inherits, so a
    // relaunched bundle's inputs and module always win over stale copies (design §5.4).
    root: inherited ? null : program.bundle,
    files: { ...(inherited?.files ?? {}), ...program.files },
    sealedStage: -1,
    computeSamples: [],
    computeMsUsed: 0,
    computeMsCap: ledger.config.computeMsCap,
    tasksCreated: 0,
    followUp: null,
    inheritedFrom: inherited?.executionId ?? null,
    failure: null,
    counters: emptyCounters(),
  };
  ledger.executions.set(executionId, exec);
  if (req.human) {
    const firstAutomatic = ledger.queue.findIndex(
      (id) => ledger.executions.get(id)?.human === false,
    );
    if (firstAutomatic === -1) ledger.queue.push(executionId);
    else ledger.queue.splice(firstAutomatic, 0, executionId);
  } else {
    ledger.queue.push(executionId);
  }
  const effects = broadcast(ledger, { t: "executionQueued", entry: queueEntry(exec) });
  effects.push(...maybeStart(ledger, now));
  return { effects, executionId };
}

function resolveInherit(ledger: Ledger, req: LaunchRequest): ExecutionRecord | null {
  if (!req.inherit) return null;
  if (req.inherit !== "latest") {
    const e = ledger.executions.get(req.inherit);
    return e && e.status === "done" ? e : null;
  }
  let latest: ExecutionRecord | null = null;
  for (const e of ledger.executions.values()) {
    if (
      e.bundle === req.bundle &&
      e.status === "done" &&
      (!latest || (e.endedAt ?? 0) > (latest.endedAt ?? 0))
    )
      latest = e;
  }
  return latest;
}

/** Start the next queued execution when nothing is running; the first act is a plan task. */
export function maybeStart(ledger: Ledger, now: number): Effect[] {
  if (ledger.running) return [];
  const next = ledger.queue.shift();
  if (!next) return [];
  const exec = ledger.executions.get(next);
  if (!exec) return maybeStart(ledger, now);
  exec.status = "running";
  exec.startedAt = now;
  ledger.running = exec.executionId;
  const effects = broadcast(ledger, { t: "executionStarted", execution: executionView(exec) });
  const inheritedRoot = exec.inheritedFrom
    ? (ledger.executions.get(exec.inheritedFrom)?.root ?? null)
    : null;
  if (inheritedRoot) {
    // Blobs expire (a year, §5.4). Check the inherited root is still there before planning;
    // the plan task waits for the answer.
    effects.push({
      kind: "fetchBlob",
      hash: inheritedRoot,
      purpose: { type: "inheritRoot", executionId: exec.executionId },
    });
    return effects;
  }
  effects.push(...createPlanTask(ledger, exec, 0, now));
  effects.push(...fill(ledger, now));
  return effects;
}

/**
 * The answer about an inherited root (design §5.4). Present: merge the filesystems and store the
 * merged manifest, which becomes this execution's initial root. Gone: say so and start from the
 * bundle alone — a warning, not a failure, because the program can still run.
 */
export function onInheritRoot(
  ledger: Ledger,
  executionId: string,
  bytes: Uint8Array | null,
  now: number,
): Effect[] {
  const exec = ledger.executions.get(executionId);
  if (!exec || exec.status !== "running" || exec.root !== null) return [];
  const program = ledger.programs.get(exec.bundle);
  if (bytes === null) {
    exec.files = { ...(program?.files ?? {}) };
    exec.root = exec.bundle;
    const effects = broadcast(ledger, {
      t: "executionWarning",
      executionId,
      code: "expired-root",
      message: `the filesystem inherited from ${exec.inheritedFrom} is gone; starting from the bundle`,
    });
    effects.push(...createPlanTask(ledger, exec, 0, now));
    effects.push(...fill(ledger, now));
    return effects;
  }
  const manifest: FsManifest = { version: 1, files: exec.files };
  return [
    {
      kind: "putBlob",
      bytes: encoder.encode(canonicalStringify(manifest)),
      purpose: { type: "manifest", executionId, stage: -1 },
    },
  ];
}

/** The planner runs on a core like any task (D6); its input is frozen here. */
function createPlanTask(
  ledger: Ledger,
  exec: ExecutionRecord,
  stage: number,
  now: number,
): Effect[] {
  const input = encodePlanInput({
    stage,
    params: exec.params,
    hints: {
      nodes: ledger.nodes.size,
      redundancy: ledger.meta.redundancy,
      stageCount: Math.max(0, exec.stage + 1),
    },
  });
  const taskId = `t${++ledger.meta.taskCounter}`;
  const task: TaskRecord = {
    taskId,
    executionId: exec.executionId,
    stage,
    index: 0,
    kind: "plan",
    input,
    place: null,
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
  exec.planTaskId = taskId;
  exec.counters.pending += 1;
  exec.tasksCreated += 1;
  return [];
}

/** A settled task may advance its execution: a plan spec to fetch, a stage to fold, a failure to raise. */
export function afterTaskSettled(ledger: Ledger, task: TaskRecord, now: number): Effect[] {
  const exec = ledger.executions.get(task.executionId);
  if (!exec || exec.status !== "running") return [];
  if (task.status === "failed")
    return failExecution(
      ledger,
      exec,
      `task ${task.taskId} failed: ${task.failure ?? "program fault"}`,
      now,
    );
  if (exec.computeMsUsed > exec.computeMsCap)
    return failExecution(ledger, exec, "over compute budget", now);
  if (task.kind === "plan" && task.accepted) {
    return [
      {
        kind: "fetchBlob",
        hash: task.accepted.output,
        purpose: { type: "stageSpec", executionId: exec.executionId, taskId: task.taskId },
      },
    ];
  }
  if (
    exec.stageTaskIds.length > 0 &&
    exec.stageTaskIds.every((id) => ledger.tasks.get(id)?.status === "done")
  ) {
    return foldStage(ledger, exec, now);
  }
  return [];
}

/** The planner's spec arrived from the store: materialize the stage or finish the execution. */
export function onStageSpec(
  ledger: Ledger,
  executionId: string,
  taskId: string,
  bytes: Uint8Array | null,
  now: number,
): Effect[] {
  const exec = ledger.executions.get(executionId);
  const planTask = ledger.tasks.get(taskId);
  if (!exec || exec.status !== "running" || !planTask || exec.planTaskId !== taskId) return [];
  if (!bytes) return failExecution(ledger, exec, "stage spec blob missing", now);
  let spec: ReturnType<typeof decodeStageSpec>;
  try {
    spec = decodeStageSpec(bytes);
  } catch (err) {
    return failExecution(
      ledger,
      exec,
      `invalid stage spec: ${err instanceof AbiError ? err.message : String(err)}`,
      now,
    );
  }
  exec.planTaskId = null;
  if (spec.kind === "done") {
    exec.followUp = spec.next;
    return finishExecution(ledger, exec, now);
  }
  if (exec.tasksCreated + spec.tasks.length > ledger.config.taskCap) {
    return failExecution(
      ledger,
      exec,
      `stage ${planTask.stage} would make ${exec.tasksCreated + spec.tasks.length} tasks, cap is ${ledger.config.taskCap}`,
      now,
    );
  }
  const stage = planTask.stage;
  exec.stage = stage;
  exec.stageName = spec.name;
  exec.canvas = spec.canvas ?? null;
  exec.stageTaskIds = [];
  const views = [];
  for (let i = 0; i < spec.tasks.length; i++) {
    const t = spec.tasks[i];
    if (!t) continue;
    const id = `t${++ledger.meta.taskCounter}`;
    const task: TaskRecord = {
      taskId: id,
      executionId: exec.executionId,
      stage,
      index: i,
      kind: "run",
      input: t.input,
      place: t.place ?? null,
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
    ledger.tasks.set(id, task);
    exec.stageTaskIds.push(id);
    views.push(taskView(task));
  }
  exec.counters.pending += spec.tasks.length;
  exec.tasksCreated += spec.tasks.length;
  const effects = broadcast(ledger, {
    t: "stageStarted",
    executionId: exec.executionId,
    stage,
    name: spec.name,
    taskCount: spec.tasks.length,
    canvas: exec.canvas,
    tasks: views.slice(0, 256),
  });
  effects.push(...fill(ledger, now));
  return effects;
}

/** Fold outputs and writes into the next filesystem manifest (design §5.4, §6.6). */
function foldStage(ledger: Ledger, exec: ExecutionRecord, now: number): Effect[] {
  const files: FsManifest["files"] = { ...exec.files };
  const written = new Map<string, string>();
  for (const id of exec.stageTaskIds) {
    const task = ledger.tasks.get(id);
    if (!task?.accepted) continue;
    files[`/out/${exec.stage}/${task.index}`] = {
      hash: task.accepted.output,
      size: task.accepted.outputSize,
    };
    for (const w of task.accepted.writes) {
      const prior = written.get(w.path);
      if (prior !== undefined && prior !== w.hash)
        return failExecution(ledger, exec, `write conflict at ${w.path}`, now);
      written.set(w.path, w.hash);
      files[w.path] = { hash: w.hash, size: w.size };
    }
  }
  const bytes = Object.values(files).reduce((n, f) => n + f.size, 0);
  if (bytes > ledger.config.fsBytesCap) {
    return failExecution(
      ledger,
      exec,
      `filesystem is ${bytes} bytes, cap is ${ledger.config.fsBytesCap}`,
      now,
    );
  }
  const manifest: FsManifest = { version: 1, files };
  exec.sealedStage = exec.stage;
  return [
    {
      kind: "putBlob",
      bytes: encoder.encode(canonicalStringify(manifest)),
      purpose: { type: "manifest", executionId: exec.executionId, stage: exec.stage },
    },
  ];
}

/** The folded manifest is in the store: advance the root and plan the next stage. */
export function onManifestStored(
  ledger: Ledger,
  executionId: string,
  stage: number,
  hash: string,
  now: number,
): Effect[] {
  const exec = ledger.executions.get(executionId);
  if (!exec || exec.status !== "running") return [];
  if (stage === -1) {
    // The initial filesystem of an execution that inherited one: plan can start now.
    if (exec.root !== null) return [];
    exec.root = hash;
    return [...createPlanTask(ledger, exec, 0, now), ...fill(ledger, now)];
  }
  if (exec.stage !== stage || exec.planTaskId) return [];
  const files: FsManifest["files"] = { ...exec.files };
  for (const id of exec.stageTaskIds) {
    const task = ledger.tasks.get(id);
    if (!task?.accepted) continue;
    files[`/out/${exec.stage}/${task.index}`] = {
      hash: task.accepted.output,
      size: task.accepted.outputSize,
    };
    for (const w of task.accepted.writes) files[w.path] = { hash: w.hash, size: w.size };
  }
  exec.files = files;
  exec.root = hash;
  const effects = broadcast(ledger, { t: "stageDone", executionId, stage, root: hash });
  effects.push(...createPlanTask(ledger, exec, stage + 1, now));
  effects.push(...fill(ledger, now));
  return effects;
}

/** How long the default loop waits after a failed execution: doubling from five seconds to five minutes. */
export const LOOP_BACKOFF_MIN_MS = 5_000;
export const LOOP_BACKOFF_MAX_MS = 300_000;
/** Ended executions kept in the ledger (and the snapshot); older ones and their tasks are pruned. */
export const KEEP_ENDED_EXECUTIONS = 32;

function isDefaultLoop(ledger: Ledger, exec: ExecutionRecord): boolean {
  return !exec.human && ledger.config.defaultLoop?.bundle === exec.bundle;
}

function finishExecution(ledger: Ledger, exec: ExecutionRecord, now: number): Effect[] {
  const effects: Effect[] = [];
  // Nothing should be open by now; whatever is gets cancelled so no node holds finished work.
  for (const task of currentTasks(ledger, exec)) effects.push(...cancelOthers(ledger, task, null));
  exec.status = "done";
  exec.endedAt = now;
  ledger.running = null;
  if (isDefaultLoop(ledger, exec)) ledger.meta.loopBackoffMs = 0;
  effects.push(
    ...broadcast(ledger, {
      t: "executionDone",
      executionId: exec.executionId,
      root: exec.root,
      followUp: exec.followUp,
    }),
  );
  // Only the machine's default loop continues on its own (D19).
  if (
    !exec.human &&
    exec.followUp &&
    ledger.config.defaultLoop &&
    exec.bundle === ledger.config.defaultLoop.bundle &&
    ledger.observers.size > 0
  ) {
    effects.push(
      ...enqueue(
        ledger,
        { bundle: exec.bundle, params: exec.followUp, human: false, inherit: exec.executionId },
        now,
      ).effects,
    );
  }
  effects.push(...maybeStart(ledger, now));
  return effects;
}

/** Open tasks of an ending execution are settled as failed so nothing dangles (design §6.10). */
function settleOpenTasks(
  ledger: Ledger,
  exec: ExecutionRecord,
  reason: string,
  now: number,
): Effect[] {
  const effects: Effect[] = [];
  for (const task of currentTasks(ledger, exec)) {
    effects.push(...cancelOthers(ledger, task, null));
    if (task.status === "pending" || task.status === "assigned") {
      task.status = "failed";
      task.failure = reason;
      task.doneAt = now;
    }
  }
  return effects;
}

export function failExecution(
  ledger: Ledger,
  exec: ExecutionRecord,
  reason: string,
  now: number,
): Effect[] {
  const effects: Effect[] = [];
  effects.push(...settleOpenTasks(ledger, exec, reason, now));
  exec.status = "failed";
  exec.failure = reason;
  exec.endedAt = now;
  if (ledger.running === exec.executionId) ledger.running = null;
  if (isDefaultLoop(ledger, exec)) {
    // A failing loop must not spin: back off, doubling, before the next automatic launch.
    const delay = Math.min(
      Math.max(ledger.meta.loopBackoffMs * 2, LOOP_BACKOFF_MIN_MS),
      LOOP_BACKOFF_MAX_MS,
    );
    ledger.meta.loopBackoffMs = delay;
    ledger.meta.loopPausedUntil = now + delay;
  }
  effects.push(
    ...broadcast(ledger, { t: "executionFailed", executionId: exec.executionId, reason }),
  );
  effects.push(...maybeStart(ledger, now));
  return effects;
}

export function cancelExecution(
  ledger: Ledger,
  exec: ExecutionRecord,
  reason: string,
  now: number,
): Effect[] {
  const effects: Effect[] = [];
  if (exec.status === "queued") {
    ledger.queue = ledger.queue.filter((id) => id !== exec.executionId);
    exec.status = "cancelled";
    exec.endedAt = now;
    effects.push(
      ...broadcast(ledger, { t: "executionFailed", executionId: exec.executionId, reason }),
    );
    return effects;
  }
  if (exec.status !== "running") return effects;
  effects.push(...settleOpenTasks(ledger, exec, reason, now));
  exec.status = "cancelled";
  exec.failure = reason;
  exec.endedAt = now;
  ledger.running = null;
  effects.push(
    ...broadcast(ledger, { t: "executionFailed", executionId: exec.executionId, reason }),
  );
  return effects;
}

export function currentTasks(ledger: Ledger, exec: ExecutionRecord): TaskRecord[] {
  const ids = exec.planTaskId ? [exec.planTaskId, ...exec.stageTaskIds] : exec.stageTaskIds;
  return ids.map((id) => ledger.tasks.get(id)).filter((t): t is TaskRecord => t !== undefined);
}

/** Every task of an execution, all stages, in stage and index order (for snapshots). */
export function executionTasks(ledger: Ledger, executionId: string): TaskRecord[] {
  return [...ledger.tasks.values()]
    .filter((t) => t.executionId === executionId)
    .sort((a, b) => a.stage - b.stage || a.index - b.index || (a.kind === "plan" ? -1 : 1));
}

/** The default loop keeps the machine busy while someone is watching (D4, §6.8). */
export function ensureDefaultLoop(ledger: Ledger, now: number): Effect[] {
  const loop = ledger.config.defaultLoop;
  if (!loop || ledger.running || ledger.queue.length > 0 || ledger.observers.size === 0) return [];
  if (!ledger.meta.awake) return []; // asleep: automatic continuation pauses (design §6.8)
  if (now < (ledger.meta.loopPausedUntil ?? 0)) return [];
  if (!ledger.programs.has(loop.bundle)) return [];
  return enqueue(
    ledger,
    { bundle: loop.bundle, params: loop.params, human: false, inherit: null },
    now,
  ).effects;
}

/** Demo controls (design §6.7): pick victims across the whole cluster and command them. */
export function commandHalf(
  ledger: Ledger,
  op: "close" | "freeze" | "throttle",
  rng: () => number,
): { effects: Effect[]; victims: string[] } {
  const nodes = [...ledger.nodes.values()];
  for (let i = nodes.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = nodes[i] as NodeRecord;
    nodes[i] = nodes[j] as NodeRecord;
    nodes[j] = a;
  }
  const victims = nodes.slice(0, Math.ceil(nodes.length / 2));
  const effects: Effect[] = [];
  for (const v of victims) {
    // Freeze is terminal (design §4, §6.7): a frozen worker computes nothing and is declared gone
    // within the silence window. Downgrading its record to `throttle` would make `fill` hand it
    // work it can never do, so a later throttle leaves a frozen node frozen.
    if (op === "throttle" && v.commanded !== "freeze") v.commanded = "throttle";
    if (op === "freeze") v.commanded = "freeze";
    effects.push({
      kind: "send",
      connId: v.connId,
      msg: { t: "command", v: PROTOCOL_VERSION, gen: ledger.meta.generation, op },
    });
  }
  return { effects, victims: victims.map((v) => v.nodeId) };
}

export function resumeAll(ledger: Ledger): { effects: Effect[]; victims: string[] } {
  const effects: Effect[] = [];
  const victims: string[] = [];
  for (const n of ledger.nodes.values()) {
    if (n.commanded !== "throttle") continue;
    n.commanded = null;
    victims.push(n.nodeId);
    effects.push({
      kind: "send",
      connId: n.connId,
      msg: { t: "command", v: PROTOCOL_VERSION, gen: ledger.meta.generation, op: "resume" },
    });
  }
  return { effects, victims };
}

/**
 * Keep the ledger small: ended executions beyond the most recent `keep` are dropped with their
 * tasks. Results live in the store by hash, and a continuation copies what it inherits at
 * enqueue, so nothing live points at what is pruned.
 */
export function pruneExecutions(ledger: Ledger, keep = KEEP_ENDED_EXECUTIONS): string[] {
  const ended = [...ledger.executions.values()]
    .filter((e) => e.status === "done" || e.status === "failed" || e.status === "cancelled")
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  const pruned: string[] = [];
  for (const exec of ended.slice(keep)) {
    for (const [taskId, task] of ledger.tasks) {
      if (task.executionId === exec.executionId) ledger.tasks.delete(taskId);
    }
    ledger.executions.delete(exec.executionId);
    pruned.push(exec.executionId);
  }
  return pruned;
}
