// The execution state machine (design §5.4, §6.6, §6.7): queued, running through plan and stage
// tasks with the store answering in between, ended. Nothing here kicks the scheduler or the loop;
// `advance` does that once, after the event.
import {
  AbiError,
  byteLength,
  canonicalStringify,
  decodeStageSpec,
  encodePlanInput,
  type FsManifest,
  fsManifest,
} from "@tabframe/protocol";
import type { Effect, FetchResult } from "./events.ts";
import {
  type BlobPurpose,
  type ExecutionRecord,
  emptyCounters,
  executionView,
  type FetchPurpose,
  type LaunchRequest,
  type Ledger,
  type PutPurpose,
  queueEntry,
  type TaskRecord,
  taskView,
} from "./ledger.ts";
import { loopContinuation, loopEnded, loopMayRun, unyieldLoop, yieldLoop } from "./loop.ts";
import { broadcast } from "./observers.ts";
import { PARAMS_MAX_BYTES, QUEUE_CAP, STORE_ERRORS_MAX, STORE_RETRY_MS } from "./policy.ts";
import { cancelOthers, newTask, setStatus, stageTasks } from "./tasks.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The running execution, if any. */
export function runningExecution(ledger: Ledger): ExecutionRecord | undefined {
  return ledger.running ? ledger.executions.get(ledger.running) : undefined;
}

/** The execution matching `pred` that ended last; ties go to the earlier record. */
export function latestExecution(
  ledger: Ledger,
  pred: (e: ExecutionRecord) => boolean,
): ExecutionRecord | undefined {
  let latest: ExecutionRecord | undefined;
  for (const e of ledger.executions.values()) {
    if (!pred(e)) continue;
    if (!latest || (e.endedAt ?? 0) > (latest.endedAt ?? 0)) latest = e;
  }
  return latest;
}

/** Every task of an execution, all stages, in stage and index order (for snapshots). */
export function executionTasks(ledger: Ledger, executionId: string): TaskRecord[] {
  return [...ledger.tasks.values()]
    .filter((t) => t.executionId === executionId)
    .sort((a, b) => a.stage - b.stage || a.index - b.index || (a.kind === "plan" ? -1 : 1));
}

/** Queue an execution and start it if the machine is idle; human launches go ahead of automatic continuations (design §6.7). */
export function enqueue(
  ledger: Ledger,
  req: LaunchRequest,
  now: number,
): { effects: Effect[]; executionId: string | null; error?: string } {
  const program = ledger.programs.get(req.bundle);
  if (!program) return { effects: [], executionId: null, error: "unknown program" };
  if (program.retired) return { effects: [], executionId: null, error: "program retired" };
  if (byteLength(canonicalStringify(req.params)) > PARAMS_MAX_BYTES)
    return { effects: [], executionId: null, error: `params over ${PARAMS_MAX_BYTES} bytes` };
  if (ledger.queue.length >= QUEUE_CAP)
    return { effects: [], executionId: null, error: `queue full (${QUEUE_CAP})` };
  // A `persist` program inherits the latest finished run of itself unless told otherwise (D5).
  const inherit = req.inherit ?? (program.manifest.persist ? "latest" : null);
  const inherited = resolveInherit(ledger, req.bundle, inherit);
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
    // The filesystem starts from the bundle's own files; what it inherits is read back from the
    // inherited root's manifest when the run starts, overlaid so a relaunched bundle's inputs and
    // module win over stale copies (design §5.4). The ledger's copy of the origin's file map may be
    // pruned by then, the blob is not.
    root: inherited ? null : program.bundle,
    files: { ...program.files },
    sealedStage: -1,
    computeSamples: [],
    computeMsUsed: 0,
    computeMsCap: ledger.config.computeMsCap,
    tasksCreated: 0,
    followUp: null,
    inheritedFrom: inherited?.executionId ?? null,
    failure: null,
    counters: emptyCounters(),
    awaiting: null,
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

function resolveInherit(
  ledger: Ledger,
  bundle: string,
  inherit: string | "latest" | null,
): ExecutionRecord | null {
  if (!inherit) return null;
  if (inherit !== "latest") {
    const e = ledger.executions.get(inherit);
    return e && e.status === "done" ? e : null;
  }
  return latestExecution(ledger, (e) => e.bundle === bundle && e.status === "done") ?? null;
}

/** Start the next queued execution when nothing is running; the first act is a plan task. */
export function maybeStart(ledger: Ledger, now: number): Effect[] {
  if (ledger.running || ledger.session.pausedBy !== null) return [];
  const nextId = ledger.queue[0];
  if (nextId === undefined) return [];
  const queued = ledger.executions.get(nextId);
  if (!queued) {
    ledger.queue.shift();
    return maybeStart(ledger, now);
  }
  // The loop's gate holds its queued continuations too, not only new launches: after a person's
  // launch ends, the follow-up the previous frame left in the queue would otherwise take the
  // stage at once. A person's own launch never waits.
  if (!queued.human && (!loopMayRun(ledger, now) || now < (ledger.meta.loopPausedUntil ?? 0)))
    return [];
  ledger.queue.shift();
  const exec = queued;
  exec.status = "running";
  exec.startedAt = now;
  ledger.running = exec.executionId;
  const effects = exec.human ? [] : unyieldLoop(ledger); // the loop is back; a person's launch keeps the yield
  effects.push(...broadcast(ledger, { t: "executionStarted", execution: executionView(exec) }));
  if (exec.root === null) {
    // An inherited filesystem: blobs expire (design §5.4), so the root is checked before planning
    // and the plan task waits for the answer.
    effects.push(
      ...issue(ledger, exec, { type: "inheritRoot", executionId: exec.executionId }, now),
    );
    return effects;
  }
  createPlanTask(ledger, exec, 0, now);
  return effects;
}

/** The root of the execution this one inherits from, null when that execution or its root is gone. */
function originRoot(ledger: Ledger, exec: ExecutionRecord): string | null {
  return exec.inheritedFrom ? (ledger.executions.get(exec.inheritedFrom)?.root ?? null) : null;
}

function samePurpose(a: BlobPurpose, b: BlobPurpose): boolean {
  if (a.type !== b.type || a.executionId !== b.executionId) return false;
  if (a.type === "stageSpec" && b.type === "stageSpec") return a.taskId === b.taskId;
  if (a.type === "manifest" && b.type === "manifest") return a.stage === b.stage;
  return true;
}

/** Is this the store answer the execution is waiting for? Anything else is stale or a repeat. */
function answered(exec: ExecutionRecord, purpose: BlobPurpose): boolean {
  return (
    exec.status === "running" &&
    exec.awaiting !== null &&
    samePurpose(exec.awaiting.purpose, purpose)
  );
}

/**
 * Ask the process for the store answer the execution needs next and remember what is awaited, so
 * a silent store or a mid-flight adoption can ask again. Errors on the same purpose carry over.
 */
function issue(ledger: Ledger, exec: ExecutionRecord, purpose: BlobPurpose, now: number): Effect[] {
  const errors =
    exec.awaiting && samePurpose(exec.awaiting.purpose, purpose) ? exec.awaiting.errors : 0;
  switch (purpose.type) {
    case "inheritRoot": {
      const root = originRoot(ledger, exec);
      // The origin was pruned between enqueue and start: say so and start from the bundle.
      if (root === null) return inheritFrom(ledger, exec, null, "gone", now);
      exec.awaiting = { purpose, since: now, errors };
      return [{ kind: "fetchBlob", hash: root, purpose }];
    }
    case "stageSpec": {
      const plan = ledger.tasks.get(purpose.taskId);
      if (plan?.status !== "done" || !plan.accepted) return [];
      exec.awaiting = { purpose, since: now, errors };
      return [{ kind: "fetchBlob", hash: plan.accepted.output, purpose }];
    }
    case "manifest": {
      const files = purpose.stage === -1 ? exec.files : stageFiles(ledger, exec).files;
      exec.awaiting = { purpose, since: now, errors };
      return [{ kind: "putBlob", bytes: manifestBytes(files), purpose }];
    }
  }
}

function manifestBytes(files: FsManifest["files"]): Uint8Array {
  const manifest: FsManifest = { version: 1, files };
  return encoder.encode(canonicalStringify(manifest));
}

/** The store answered a fetch the core asked for. */
export function onFetched(
  ledger: Ledger,
  purpose: FetchPurpose,
  result: FetchResult,
  now: number,
): Effect[] {
  const exec = ledger.executions.get(purpose.executionId);
  if (!exec || !answered(exec, purpose)) return [];
  if (result.kind === "error") return storeError(ledger, exec, result.reason, now);
  const bytes = result.kind === "bytes" ? result.bytes : null;
  switch (purpose.type) {
    case "stageSpec": {
      const planTask = ledger.tasks.get(purpose.taskId);
      if (!planTask) return [];
      return onStageSpec(ledger, exec, planTask, bytes, now);
    }
    case "inheritRoot": {
      if (bytes === null) return inheritFrom(ledger, exec, null, "gone", now);
      return inheritFrom(ledger, exec, parseManifest(bytes), "unreadable", now);
    }
  }
}

/**
 * The answer about an inherited root (design §5.4). Present: merge the filesystems and store the
 * merged manifest, which becomes this execution's initial root. Gone or unreadable: say so and
 * start from the bundle alone — a warning, not a failure, because the program can still run.
 */
function inheritFrom(
  ledger: Ledger,
  exec: ExecutionRecord,
  inherited: FsManifest["files"] | null,
  why: "gone" | "unreadable",
  now: number,
): Effect[] {
  exec.awaiting = null;
  const program = ledger.programs.get(exec.bundle);
  if (inherited === null) {
    exec.files = { ...(program?.files ?? {}) };
    exec.root = exec.bundle;
    const effects = broadcast(ledger, {
      t: "executionWarning",
      executionId: exec.executionId,
      code: "expired-root",
      message: `the filesystem inherited from ${exec.inheritedFrom} is ${why}; starting from the bundle`,
    });
    createPlanTask(ledger, exec, 0, now);
    return effects;
  }
  exec.files = { ...inherited, ...(program?.files ?? {}) };
  return issue(ledger, exec, { type: "manifest", executionId: exec.executionId, stage: -1 }, now);
}

/** The inherited root's manifest, or null when the blob is not one (design §5.4). */
function parseManifest(bytes: Uint8Array): FsManifest["files"] | null {
  try {
    const parsed = fsManifest.safeParse(JSON.parse(decoder.decode(bytes)));
    return parsed.success ? parsed.data.files : null;
  } catch {
    return null;
  }
}

/** The planner runs on a core like any task (D6); its input is frozen here. */
function createPlanTask(ledger: Ledger, exec: ExecutionRecord, stage: number, now: number): void {
  const input = encodePlanInput({
    stage,
    params: exec.params,
    hints: {
      nodes: ledger.nodes.size,
      redundancy: ledger.meta.redundancy,
      stageCount: Math.max(0, exec.stage + 1),
    },
  });
  const task = newTask(ledger, exec, { stage, index: 0, kind: "plan", input, place: null }, now);
  exec.planTaskId = task.taskId;
}

/** A settled task may advance its execution: a plan spec to fetch, a stage to fold, a failure to raise. */
export function afterTaskSettled(ledger: Ledger, task: TaskRecord, now: number): Effect[] {
  const exec = ledger.executions.get(task.executionId);
  if (exec?.status !== "running") return [];
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
    return issue(
      ledger,
      exec,
      { type: "stageSpec", executionId: exec.executionId, taskId: task.taskId },
      now,
    );
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
function onStageSpec(
  ledger: Ledger,
  exec: ExecutionRecord,
  planTask: TaskRecord,
  bytes: Uint8Array | null,
  now: number,
): Effect[] {
  exec.awaiting = null;
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
    const task = newTask(
      ledger,
      exec,
      { stage, index: i, kind: "run", input: t.input, place: t.place ?? null },
      now,
    );
    exec.stageTaskIds.push(task.taskId);
    views.push(taskView(task));
  }
  return broadcast(ledger, {
    t: "stageStarted",
    executionId: exec.executionId,
    stage,
    name: spec.name,
    taskCount: spec.tasks.length,
    canvas: exec.canvas,
    tasks: views.slice(0, 256),
  });
}

/**
 * The current stage's filesystem: the previous one plus each task's output at
 * `/out/<stage>/<index>` and its writes, and the first path two tasks wrote differently, if any.
 */
function stageFiles(
  ledger: Ledger,
  exec: ExecutionRecord,
): { files: FsManifest["files"]; conflict: string | null } {
  const files: FsManifest["files"] = { ...exec.files };
  const written = new Map<string, string>();
  let conflict: string | null = null;
  for (const id of exec.stageTaskIds) {
    const task = ledger.tasks.get(id);
    if (!task?.accepted) continue;
    files[`/out/${exec.stage}/${task.index}`] = {
      hash: task.accepted.output,
      size: task.accepted.outputSize,
    };
    for (const w of task.accepted.writes) {
      const prior = written.get(w.path);
      if (prior !== undefined && prior !== w.hash && conflict === null) conflict = w.path;
      written.set(w.path, w.hash);
      files[w.path] = { hash: w.hash, size: w.size };
    }
  }
  return { files, conflict };
}

/** Fold outputs and writes into the next filesystem manifest (design §5.4, §6.6). */
function foldStage(ledger: Ledger, exec: ExecutionRecord, now: number): Effect[] {
  const { files, conflict } = stageFiles(ledger, exec);
  if (conflict !== null) return failExecution(ledger, exec, `write conflict at ${conflict}`, now);
  const bytes = Object.values(files).reduce((n, f) => n + f.size, 0);
  if (bytes > ledger.config.fsBytesCap) {
    return failExecution(
      ledger,
      exec,
      `filesystem is ${bytes} bytes, cap is ${ledger.config.fsBytesCap}`,
      now,
    );
  }
  exec.sealedStage = exec.stage;
  return issue(
    ledger,
    exec,
    { type: "manifest", executionId: exec.executionId, stage: exec.stage },
    now,
  );
}

/** The folded manifest is in the store: advance the root and plan the next stage. */
export function onManifestStored(
  ledger: Ledger,
  purpose: PutPurpose,
  hash: string,
  now: number,
): Effect[] {
  const exec = ledger.executions.get(purpose.executionId);
  if (!exec || !answered(exec, purpose)) return [];
  exec.awaiting = null;
  if (purpose.stage === -1) {
    // The initial filesystem of an execution that inherited one: planning can start now.
    exec.root = hash;
    createPlanTask(ledger, exec, 0, now);
    return [];
  }
  exec.files = stageFiles(ledger, exec).files;
  exec.root = hash;
  const effects = broadcast(ledger, {
    t: "stageDone",
    executionId: exec.executionId,
    stage: purpose.stage,
    root: hash,
  });
  createPlanTask(ledger, exec, purpose.stage + 1, now);
  return effects;
}

/**
 * The store answered the pending effect with an error rather than bytes: not "missing", so the
 * execution keeps waiting and `resumePending` asks again; past `STORE_ERRORS_MAX` it fails with
 * the store's reason. The retry interval counts from the original request.
 */
function storeError(ledger: Ledger, exec: ExecutionRecord, reason: string, now: number): Effect[] {
  if (!exec.awaiting) return [];
  exec.awaiting.errors += 1;
  if (exec.awaiting.errors > STORE_ERRORS_MAX)
    return failExecution(ledger, exec, `the store kept failing: ${reason.slice(0, 200)}`, now);
  return [];
}

/**
 * Issue the store effect the running execution is waiting on again: the effects are
 * fire-and-forget, so a control plane that adopted the ledger mid-flight, or a store that stayed
 * silent, would otherwise leave the execution running for ever. Every one is idempotent: blobs are
 * content-addressed and an answer that arrived already is ignored. Called on adopt (`force`) and
 * on every tick once `STORE_RETRY_MS` have passed.
 */
export function resumePending(ledger: Ledger, now: number, force = false): Effect[] {
  const exec = runningExecution(ledger);
  if (exec?.status !== "running" || !exec.awaiting) return [];
  if (!force && now - exec.awaiting.since < STORE_RETRY_MS) return [];
  return issue(ledger, exec, exec.awaiting.purpose, now);
}

/**
 * The store answer a running execution needs next, read off its state: for snapshots written
 * before the ledger recorded what it was waiting for.
 */
export function pendingPurpose(ledger: Ledger, exec: ExecutionRecord): BlobPurpose | null {
  const executionId = exec.executionId;
  if (exec.root === null && !exec.planTaskId && exec.stageTaskIds.length === 0)
    return { type: "inheritRoot", executionId };
  if (exec.planTaskId) {
    const plan = ledger.tasks.get(exec.planTaskId);
    if (plan?.status !== "done" || !plan.accepted) return null;
    return { type: "stageSpec", executionId, taskId: plan.taskId };
  }
  if (
    exec.stageTaskIds.length > 0 &&
    exec.stageTaskIds.every((id) => ledger.tasks.get(id)?.status === "done")
  )
    return { type: "manifest", executionId, stage: exec.stage };
  return null;
}

type End = { status: "done" } | { status: "failed" | "cancelled"; reason: string };

/**
 * The one way an execution ends: open tasks settled so nothing dangles (design §6.10), the loop
 * told so it can back off or reset, the yield to a person, and the announcement. Who runs next is
 * `advance`'s business.
 */
function endExecution(ledger: Ledger, exec: ExecutionRecord, end: End, now: number): Effect[] {
  const effects: Effect[] = [];
  if (exec.status === "queued") ledger.queue = ledger.queue.filter((id) => id !== exec.executionId);
  if (exec.status === "running") {
    const reason = end.status === "done" ? "execution finished" : end.reason;
    for (const task of stageTasks(ledger, exec)) {
      effects.push(...cancelOthers(ledger, task, null));
      if (task.status === "pending" || task.status === "assigned") {
        setStatus(exec, task, "failed");
        task.failure = reason;
        task.doneAt = now;
      }
    }
    if (end.status !== "done") exec.failure = end.reason;
  }
  exec.status = end.status;
  exec.endedAt = now;
  exec.awaiting = null;
  if (ledger.running === exec.executionId) ledger.running = null;
  loopEnded(ledger, exec, end.status, now);
  effects.push(...yieldLoop(ledger, exec));
  effects.push(
    ...broadcast(
      ledger,
      end.status === "done"
        ? {
            t: "executionDone",
            executionId: exec.executionId,
            root: exec.root,
            followUp: exec.followUp,
          }
        : { t: "executionFailed", executionId: exec.executionId, reason: end.reason },
    ),
  );
  return effects;
}

function finishExecution(ledger: Ledger, exec: ExecutionRecord, now: number): Effect[] {
  const effects = endExecution(ledger, exec, { status: "done" }, now);
  const next = loopContinuation(ledger, exec);
  if (next) effects.push(...enqueue(ledger, next, now).effects);
  return effects;
}

function failExecution(
  ledger: Ledger,
  exec: ExecutionRecord,
  reason: string,
  now: number,
): Effect[] {
  return endExecution(ledger, exec, { status: "failed", reason }, now);
}

/** A person or a control ended it; nothing happens to one that has already ended. */
export function cancelExecution(
  ledger: Ledger,
  exec: ExecutionRecord,
  reason: string,
  now: number,
): Effect[] {
  if (exec.status !== "queued" && exec.status !== "running") return [];
  return endExecution(ledger, exec, { status: "cancelled", reason }, now);
}
