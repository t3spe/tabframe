// The ledger: everything the control plane knows, as plain records (design §6.1, §6.2). Durable
// state lives in `meta`, `config`, and the record maps; what belongs to one process — sockets,
// holds, budgets — lives in `conns`, `nodeByConn`, `observers`, and `session`, and a successor
// starts those fresh.
import type {
  Counters,
  ExecutionView,
  FsManifest,
  Health,
  NodeKind,
  NodeView,
  Place,
  ProgramManifest,
  QueueEntry,
  TaskLimits,
  TaskView,
} from "@tabframe/protocol";
import { BUDGETS, type Bucket, newBucket } from "./budgets.ts";
import { CONFIG_DEFAULTS, DEFAULT_TASK_LIMITS } from "./policy.ts";

/** The wire's `NodeKind` as the core reads it: "tab" is a browser tab, "core" a cloud core (a MicroVM the fleet launched). */
export type WorkerKind = NodeKind;

/** One live node: everything the control plane knows about a worker (design §6.2). */
export interface NodeRecord {
  nodeId: string;
  connId: string;
  hostId: string;
  kind: WorkerKind;
  cores: number;
  sandboxVersion: string;
  joinedAt: number;
  lastSeen: number;
  visible: boolean;
  health: Health;
  tasksDone: number;
  lastTaskMs: number | null;
  /** Exponentially weighted compute time, the basis of fast/slow. */
  ewmaMs: number | null;
  /** Task ids with an open attempt on this node. */
  inFlight: string[];
  /** The last demo command applied, so resumeAll knows whom to resume. */
  commanded: "throttle" | "freeze" | null;
  /** When the last heartbeat was taken; ones arriving faster than half the period are dropped. */
  heartbeatAt: number | null;
  /** The health observers were last told, and when. */
  announcedHealth: Health | null;
  healthAnnouncedAt: number | null;
}

/** One dashboard connection. */
export interface ObserverRecord {
  connId: string;
  subscribedAt: number;
  lastSeen: number;
  /** When this observer launched executions, for the per-observer rate limit (design §5.5). */
  launchedAt: number[];
}

export type ConnRole = "node" | "observer";

/** Per-connection state, kept from the socket opening until it closes. */
export interface ConnState {
  connId: string;
  role: ConnRole;
  openedAt: number;
  /** What the connection sends on its own initiative. */
  messages: Bucket;
  /** Results and presigns, which answer assignments. */
  solicited: Bucket;
  /** Presigned bytes this connection asked for. */
  presignBytes: Bucket;
}

/** "released": the node gave the task back at its deadline; "lost": the node went away. */
export type AttemptOutcome = "running" | "result" | "released" | "lost" | "cancelled" | "error";

export interface AttemptRecord {
  attempt: number;
  nodeId: string;
  assignedAt: number;
  deadlineAt: number;
  /** True when this attempt was opened as a speculative twin (tier three). */
  speculative: boolean;
  outcome: AttemptOutcome;
}

export interface WriteRecord {
  path: string;
  hash: string;
  size: number;
}

/** One reported result, kept until the task is settled so twins and contested rounds can be compared. */
export interface ResultRecord {
  /** Canonical string of output + sorted writes: equal identities mean identical bytes (design §5.4). */
  identity: string;
  output: string;
  outputSize: number;
  writes: WriteRecord[];
  log: { hash: string } | { text: string } | null;
  nodeId: string;
  attempt: number;
  computeMs: number;
  round: number;
}

export type TaskStatus = "pending" | "assigned" | "done" | "failed";

export interface TaskRecord {
  taskId: string;
  executionId: string;
  stage: number;
  index: number;
  kind: "run" | "plan";
  /** Inline input from the stage spec (the ABI framing is added by the node). */
  input: Uint8Array;
  place: Place | null;
  status: TaskStatus;
  attempts: AttemptRecord[];
  results: ResultRecord[];
  /** The accepted result, once settled. */
  accepted: ResultRecord | null;
  /** Set when the task was ever released by a dead node; released work outranks fresh work. */
  released: boolean;
  /** Mismatch rounds so far; the third round is resolved by majority (D7). */
  contestedRounds: number;
  /** True when settled by majority vote rather than agreement. */
  resolvedByVote: boolean;
  /** How many identical results are needed to settle: 1, or 2 with the redundancy toggle. */
  requiredAgreement: 1 | 2;
  createdAt: number;
  doneAt: number | null;
  failure: string | null;
}

export type ExecutionStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface ExecutionRecord {
  executionId: string;
  /** The bundle hash; the program's module and manifest are looked up in `programs`. */
  bundle: string;
  manifest: ProgramManifest;
  params: Record<string, unknown>;
  human: boolean;
  status: ExecutionStatus;
  queuedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** Current stage index; -1 while the first plan task runs. */
  stage: number;
  stageName: string;
  canvas: { w: number; h: number } | null;
  /** Task ids of the current stage in fill order (after the current plan task). */
  stageTaskIds: string[];
  /** The plan task in flight for the next stage, if any. */
  planTaskId: string | null;
  /** The filesystem as of the current stage: root hash and its manifest. */
  root: string | null;
  files: FsManifest["files"];
  /** Highest stage whose results were folded into a manifest; late mismatches there retract nothing. */
  sealedStage: number;
  /** Rolling compute samples of this execution's run tasks, for deadlines. */
  computeSamples: number[];
  computeMsUsed: number;
  computeMsCap: number;
  /** Tasks created across every stage so far, against `config.taskCap`. */
  tasksCreated: number;
  followUp: Record<string, unknown> | null;
  inheritedFrom: string | null;
  failure: string | null;
  counters: Counters;
  /** When the pending store effect was issued, null while none is outstanding. */
  waitingSince: number | null;
  /** Store errors on the pending effect so far; the execution fails past a cap. */
  storeErrors: number;
}

/**
 * A cloud core the control plane launched (design §6.8). The record travels with the ledger, so
 * a successor inherits the MicroVM instead of relaunching it.
 */
export interface CloudCoreRecord {
  microvmId: string;
  launchedAt: number;
  /** The token the core's run payload carried; a hello links only by showing it. */
  token: string;
  /** The node this core connected as, once it has said hello; the process's /health reads it. */
  nodeId: string | null;
  /** Since when the core has had no node, null while linked; unlinked past the link timeout it is replaced. */
  unlinkedAt: number | null;
}

export interface ProgramRecord {
  bundle: string;
  module: string;
  manifest: ProgramManifest;
  /** The bundle's own files (design §5.1): the module, the manifest, and anything under `/in/`. */
  files: FsManifest["files"];
  addedAt: number;
  /** Superseded by a newer bundle under the same name: hidden, refusing launches, kept only while an execution refers to it. */
  retired?: boolean;
}

/**
 * Where a control plane is in its life (design §9.4). Only an `active` one assigns work; a
 * `handing-over` one has given its ledger away and is waiting to be drained.
 */
export type Phase = "active" | "handing-over" | "drained";

/** Durable machine state: what a snapshot carries and a successor inherits. */
export interface Meta {
  generation: number;
  phase: Phase;
  /** Base URL nodes and observers fetch blobs from; handed out in welcome. */
  storeBase: string;
  /** Monotonic event sequence, incremented for every event emitted to observers. */
  seq: number;
  nodeCounter: number;
  taskCounter: number;
  executionCounter: number;
  redundancy: boolean;
  startedAt: number;
  /** Last human interaction, for the sleep policy (design §6.8). */
  lastInteractionAt: number;
  /** Last moment an observer was connected, for the sleep policy. */
  lastObserverAt: number;
  /** Awake means cores are kept and the default loop runs; asleep says why. */
  awake: boolean;
  sleepReason: string | null;
  /** When the last core was launched: the account allows one RunMicrovm a second. */
  lastCoreLaunchAt: number;
  /** The default loop backs off after a failed execution: current delay and when it may relaunch. */
  loopBackoffMs: number;
  loopPausedUntil: number;
  /** A person pressed Stop: the loop launches nothing until Start; survives a rotation. */
  loopStopped: boolean;
  /** The loop yielded to a person: set when a person's launch ends, cleared by Start or by quiet minutes; survives a rotation. */
  loopYielded: boolean;
  /** Core launches asked for and not yet acknowledged, by time: counted against the desired size. */
  coreLaunches: number[];
}

/** What belongs to this process alone: gone at a handover, fresh for the successor. */
export interface Session {
  /** The observer connection holding the machine paused (design §6.7): nothing is assigned or started while set. */
  pausedBy: string | null;
  /** When each destructive control was last applied, for the cooldown. */
  lastControlAt: Record<string, number>;
  /** When the handover began; without a drain the lease brings the control plane back (design §9.4). */
  handoverAt: number | null;
  /** Launch times in the last minute, machine-wide. */
  launchesAt: number[];
  /** Machine-wide presign budgets: a client that reconnects finds them where it left them. */
  presignItems: Bucket;
  presignBytesMachine: Bucket;
  /** The snapshot page split for one (generation, seq): a subscribe storm costs one serialisation per change. */
  pageMemo: { gen: number; seq: number; pages: TaskView[][] } | null;
}

/** The session a control plane starts with, fresh or adopting. */
export function freshSession(now = 0): Session {
  return {
    pausedBy: null,
    lastControlAt: {},
    handoverAt: null,
    launchesAt: [],
    presignItems: newBucket(BUDGETS.machinePresignItems, now),
    presignBytesMachine: newBucket(BUDGETS.machinePresignBytes, now),
    pageMemo: null,
  };
}

export interface LedgerConfig {
  storeBase: string;
  /** The machine's default loop: launched automatically whenever the queue is empty and someone is watching. */
  defaultLoop?: { bundle: string; params: Record<string, unknown> } | null;
  /** Compute budget per execution in milliseconds of task time. */
  computeMsCap?: number;
  taskLimits?: TaskLimits;
  /** Cap on the total size of an execution's filesystem (design §5.5). */
  fsBytesCap?: number;
  /** Cap on the tasks one execution may create across all its stages (design §5.5). */
  taskCap?: number;
  /** Launches one observer may start per minute (design §5.5). */
  launchesPerMinute?: number;
  /** Whether this control plane can launch cloud cores; only the MicroVM image can (design §6.8). */
  cloudCores?: boolean;
  /** Deadline floor and multiplier (design §6.4). */
  deadlineFloorMs?: number;
  deadlineFactor?: number;
}

/** What a launch asks for; the loop's launches and a person's go through the same shape. */
export interface LaunchRequest {
  bundle: string;
  params: Record<string, unknown>;
  human: boolean;
  inherit: string | "latest" | null;
}

export interface Ledger {
  meta: Meta;
  config: Required<
    Pick<
      LedgerConfig,
      | "computeMsCap"
      | "taskLimits"
      | "deadlineFloorMs"
      | "deadlineFactor"
      | "fsBytesCap"
      | "taskCap"
      | "launchesPerMinute"
      | "cloudCores"
    >
  > & {
    defaultLoop: { bundle: string; params: Record<string, unknown> } | null;
  };
  session: Session;
  /** The process's sockets and who is on them; not persisted. */
  conns: Map<string, ConnState>;
  nodeByConn: Map<string, string>;
  observers: Map<string, ObserverRecord>;
  /** Nodes are persisted so an adopting control plane knows what to release (design §9.4). */
  nodes: Map<string, NodeRecord>;
  programs: Map<string, ProgramRecord>;
  /** Cloud cores by MicroVM id (design §6.8). */
  cores: Map<string, CloudCoreRecord>;
  executions: Map<string, ExecutionRecord>;
  /** Queued execution ids in order; human launches ahead of automatic continuations. */
  queue: string[];
  running: string | null;
  tasks: Map<string, TaskRecord>;
}

/** A fresh ledger for generation `generation`, its clocks starting at `now`. */
export function createLedger(generation: number, config: LedgerConfig, now = 0): Ledger {
  return {
    meta: {
      generation,
      storeBase: config.storeBase,
      seq: 0,
      nodeCounter: 0,
      taskCounter: 0,
      executionCounter: 0,
      redundancy: false,
      startedAt: now,
      lastInteractionAt: now,
      lastObserverAt: now,
      awake: true,
      sleepReason: null,
      lastCoreLaunchAt: 0,
      phase: "active",
      loopBackoffMs: 0,
      loopPausedUntil: 0,
      loopStopped: false,
      loopYielded: false,
      coreLaunches: [],
    },
    config: {
      defaultLoop: config.defaultLoop ?? null,
      computeMsCap: config.computeMsCap ?? CONFIG_DEFAULTS.computeMsCap,
      taskLimits: config.taskLimits ?? DEFAULT_TASK_LIMITS,
      fsBytesCap: config.fsBytesCap ?? CONFIG_DEFAULTS.fsBytesCap,
      taskCap: config.taskCap ?? CONFIG_DEFAULTS.taskCap,
      launchesPerMinute: config.launchesPerMinute ?? CONFIG_DEFAULTS.launchesPerMinute,
      cloudCores: config.cloudCores ?? CONFIG_DEFAULTS.cloudCores,
      deadlineFloorMs: config.deadlineFloorMs ?? CONFIG_DEFAULTS.deadlineFloorMs,
      deadlineFactor: config.deadlineFactor ?? CONFIG_DEFAULTS.deadlineFactor,
    },
    session: freshSession(now),
    conns: new Map(),
    nodeByConn: new Map(),
    observers: new Map(),
    nodes: new Map(),
    programs: new Map(),
    cores: new Map(),
    executions: new Map(),
    queue: [],
    running: null,
    tasks: new Map(),
  };
}

export function emptyCounters(): Counters {
  return {
    pending: 0,
    assigned: 0,
    done: 0,
    failed: 0,
    reassigned: 0,
    speculated: 0,
    verified: 0,
    mismatched: 0,
  };
}

export function nodeView(n: NodeRecord): NodeView {
  return {
    nodeId: n.nodeId,
    // A cloud core's MicroVM id stays out of the view: with it, anyone could name a core.
    hostId: n.kind === "core" ? "fleet" : n.hostId,
    kind: n.kind,
    health: n.health,
    visible: n.visible,
    tasksDone: n.tasksDone,
    lastTaskMs: n.lastTaskMs,
    inFlight: n.inFlight.length,
    joinedAt: n.joinedAt,
  };
}

export function taskView(t: TaskRecord): TaskView {
  return {
    taskId: t.taskId,
    executionId: t.executionId,
    stage: t.stage,
    index: t.index,
    kind: t.kind,
    status: t.status,
    holders: t.attempts.filter((a) => a.outcome === "running").map((a) => a.nodeId),
    attempts: t.attempts.length,
    // A failed task has no output: a trap's record carries an empty string, and the view's output
    // must be a hash or null for the snapshot to decode.
    output: t.status === "done" && t.accepted?.output ? t.accepted.output : null,
    place: t.place,
    contested: t.contestedRounds > 0 || t.resolvedByVote,
  };
}

export function executionView(e: ExecutionRecord): ExecutionView {
  return {
    executionId: e.executionId,
    program: e.bundle,
    programName: e.manifest.name,
    status: e.status,
    failure: e.failure,
    human: e.human,
    view: e.manifest.view,
    params: e.params,
    stage: Math.max(0, e.stage),
    stageName: e.stageName,
    taskCount: e.stageTaskIds.length,
    canvas: e.canvas,
    root: e.root,
    counters: e.counters,
    startedAt: e.startedAt,
  };
}

export function queueEntry(e: ExecutionRecord): QueueEntry {
  return {
    executionId: e.executionId,
    bundle: e.bundle,
    programName: e.manifest.name,
    human: e.human,
    queuedAt: e.queuedAt,
  };
}
