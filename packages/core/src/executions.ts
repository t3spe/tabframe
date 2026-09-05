import {
  AbiError,
  byteLength,
  canonicalStringify,
  decodeStageSpec,
  encodePlanInput,
  type FsManifest,
  fsManifest,
  PROTOCOL_VERSION,
  type ProgramManifest,
} from "@tabframe/protocol";
import type { Effect, FetchResult } from "./events.ts";
import { forgetCloudCore } from "./fleet.ts";
import {
  type BlobPurpose,
  type ExecutionRecord,
  emptyCounters,
  executionView,
  type FetchPurpose,
  type LaunchRequest,
  type Ledger,
  type NodeRecord,
  type PutPurpose,
  queueEntry,
  type TaskRecord,
  taskView,
} from "./ledger.ts";
import { broadcast } from "./observers.ts";
import {
  KEEP_ENDED_EXECUTIONS,
  KEEP_ENDED_TASKS,
  LOOP_BACKOFF_MAX_MS,
  LOOP_BACKOFF_MIN_MS,
  PARAMS_MAX_BYTES,
  PROGRAMS_CAP,
  QUEUE_CAP,
  STORE_ERRORS_MAX,
  STORE_RETRY_MS,
  YIELD_IDLE_MS,
} from "./policy.ts";
import { cancelOthers, fill } from "./scheduler.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function addProgram(
  ledger: Ledger,
  bundle: string,
  module: string,
  manifest: ProgramManifest,
  files: FsManifest["files"],
  now: number,
): Effect[] {
  ledger.programs.set(bundle, { bundle, module, manifest, files, addedAt: now });
  const effects = broadcast(ledger, { t: "programAdded", program: bundle, name: manifest.name });
  // Every program rides page 0 of every snapshot: past the cap the oldest ones nobody runs, refers
  // to, or loops on are retired.
  const live = [...ledger.programs.values()].filter((p) => !p.retired);
  if (live.length > PROGRAMS_CAP) {
    const referenced = new Set([...ledger.executions.values()].map((e) => e.bundle));
    if (ledger.config.defaultLoop) referenced.add(ledger.config.defaultLoop.bundle);
    const spare = live
      .filter((p) => p.bundle !== bundle && !referenced.has(p.bundle))
      .sort((a, b) => a.addedAt - b.addedAt);
    for (const p of spare.slice(0, live.length - PROGRAMS_CAP))
      effects.push(...retireProgram(ledger, p.bundle));
  }
  return effects;
}

/**
 * A newer bundle ships under this program's name: the record is hidden and refuses launches, so
 * the follow-up chain of the old frame ends, and it is dropped once no execution refers to it —
 * `fill` and inheritance still need the module and files of one that does.
 */
export function retireProgram(ledger: Ledger, bundle: string): Effect[] {
  const program = ledger.programs.get(bundle);
  if (!program || program.retired) return [];
  program.retired = true;
  const effects = broadcast(ledger, {
    t: "programRetired",
    program: bundle,
    name: program.manifest.name,
  });
  dropUnreferencedRetired(ledger);
  return effects;
}

function dropUnreferencedRetired(ledger: Ledger): void {
  for (const program of ledger.programs.values()) {
    if (!program.retired) continue;
    let referenced = false;
    for (const e of ledger.executions.values()) {
      if (e.bundle === program.bundle) {
        referenced = true;
        break;
      }
    }
    if (!referenced) ledger.programs.delete(program.bundle);
  }
}

/** Queue an execution: human launches go ahead of automatic continuations (design §6.7). */
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
  if (ledger.running || ledger.session.pausedBy !== null) return [];
  const nextId = ledger.queue[0];
  if (nextId === undefined) return [];
  const queued = ledger.executions.get(nextId);
  if (!queued) {
    ledger.queue.shift();
    return maybeStart(ledger, now);
  }
  // The loop's pause holds its queued continuations too, not only new launches: after a person's
  // launch ends, the follow-up the previous frame left in the queue would otherwise take the
  // stage at once. A person's own launch never waits.
  if (!queued.human && (!loopMayRun(ledger, now) || now < (ledger.meta.loopPausedUntil ?? 0)))
    return [];
  ledger.queue.shift();
  const exec = queued;
  exec.status = "running";
  exec.startedAt = now;
  ledger.running = exec.executionId;
  const effects = exec.human ? [] : releaseYield(ledger); // the loop is back; a person's launch keeps the yield
  effects.push(...broadcast(ledger, { t: "executionStarted", execution: executionView(exec) }));
  if (exec.root === null) {
    // An inherited filesystem: blobs expire (design §5.4), so the root is checked before planning
    // and the plan task waits for the answer.
    effects.push(
      ...issue(ledger, exec, { type: "inheritRoot", executionId: exec.executionId }, now),
    );
    return effects;
  }
  effects.push(...createPlanTask(ledger, exec, 0, now));
  effects.push(...fill(ledger, now));
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
    effects.push(...createPlanTask(ledger, exec, 0, now));
    effects.push(...fill(ledger, now));
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
    return [...createPlanTask(ledger, exec, 0, now), ...fill(ledger, now)];
  }
  exec.files = stageFiles(ledger, exec).files;
  exec.root = hash;
  const effects = broadcast(ledger, {
    t: "stageDone",
    executionId: exec.executionId,
    stage: purpose.stage,
    root: hash,
  });
  effects.push(...createPlanTask(ledger, exec, purpose.stage + 1, now));
  effects.push(...fill(ledger, now));
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
  const exec = ledger.running ? ledger.executions.get(ledger.running) : undefined;
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
  effects.push(...holdResult(ledger, exec, now));
  effects.push(
    ...broadcast(ledger, {
      t: "executionDone",
      executionId: exec.executionId,
      root: exec.root,
      followUp: exec.followUp,
    }),
  );
  // Only the machine's default loop continues on its own (D19), and not after a Stop or while it
  // has yielded to a person.
  if (
    !exec.human &&
    !ledger.meta.loopStopped &&
    !ledger.meta.loopYielded &&
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
  effects.push(...holdResult(ledger, exec, now));
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
    effects.push(...holdResult(ledger, exec, now));
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
  effects.push(...holdResult(ledger, exec, now));
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

/**
 * The loop yields to people (design §6.7): once a person's launch has ended — done, failed, or
 * killed — the loop launches nothing, neither a new frame nor a queued continuation, until Start
 * is pressed or nobody has touched the machine for `YIELD_IDLE_MS`. The result stays on the stage
 * for as long as the person is around.
 */
function holdResult(ledger: Ledger, exec: ExecutionRecord, _now: number): Effect[] {
  if (!exec.human || ledger.meta.loopYielded) return [];
  ledger.meta.loopYielded = true;
  return broadcast(ledger, { t: "loopYielded", yielded: true });
}

/** The loop takes the stage back — ten quiet minutes have passed — and says so. */
function releaseYield(ledger: Ledger): Effect[] {
  if (!ledger.meta.loopYielded) return [];
  ledger.meta.loopYielded = false;
  return broadcast(ledger, { t: "loopYielded", yielded: false });
}

/** The loop's gate for automatic work: stopped, yielded and someone still around, or paused. */
export function loopMayRun(ledger: Ledger, now: number): boolean {
  if (ledger.meta.loopStopped || ledger.session.pausedBy !== null) return false;
  // Nobody has touched the page for a while: the loop may come back (`releaseYield` when it does).
  return !ledger.meta.loopYielded || now - ledger.meta.lastInteractionAt >= YIELD_IDLE_MS;
}

/** The default loop keeps the machine busy while someone is watching (D4, §6.8). */
export function ensureDefaultLoop(ledger: Ledger, now: number): Effect[] {
  const loop = ledger.config.defaultLoop;
  if (!loop || ledger.running || ledger.queue.length > 0 || ledger.observers.size === 0) return [];
  if (!loopMayRun(ledger, now)) return []; // stopped, yielded to a person, or paused
  if (!ledger.meta.awake) return []; // asleep: automatic continuation pauses (design §6.8)
  if (now < (ledger.meta.loopPausedUntil ?? 0)) return [];
  if (!ledger.programs.has(loop.bundle)) return [];
  const released = releaseYield(ledger);
  return [
    ...released,
    ...enqueue(
      ledger,
      { bundle: loop.bundle, params: loop.params, human: false, inherit: null },
      now,
    ).effects,
  ];
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
    // A killed or frozen cloud core is a MicroVM with nothing left to do: a closed node never
    // reconnects and a frozen one computes nothing, so the VM goes with the command and the fleet
    // policy launches a fresh one (design §6.8).
    if (op !== "throttle" && v.kind === "core") {
      for (const core of [...ledger.cores.values()]) {
        if (core.nodeId === v.nodeId) effects.push(forgetCloudCore(ledger, core.microvmId));
      }
    }
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
 * Keep the ledger small (design §9.4): ended executions beyond the most recent `keep` are dropped
 * outright, and the tasks of ended executions beyond the most recent `keepTasks` are dropped while
 * the record stays — a record is a few hundred bytes, a frame's tasks are hundreds of kilobytes.
 * Results live in the store by hash and a continuation copies what it inherits at enqueue, so
 * nothing live points at what is pruned.
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
