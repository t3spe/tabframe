import { z } from "zod";
import { LIMITS } from "./limits.ts";
import { envelope, hash, health, millis, nodeId, nodeView, seq } from "./shared.ts";
import { executionView, params, place, queueEntry, taskLog, taskView } from "./task.ts";

const executionId = z.string().min(1).max(64);
const taskId = z.string().min(1).max(64);

/** Observer → control plane. */
export const subscribe = z.object({
  t: z.literal("subscribe"),
  ...envelope,
  /** Last sequence number seen, when resubscribing after a gap. */
  since: seq.optional(),
});

export const ping = z.object({ t: z.literal("ping"), ...envelope });

/** Bundle uploads presign through the observer socket (design D18). */
export const observerPresign = z.object({
  t: z.literal("presign"),
  ...envelope,
  items: z
    .array(z.object({ hash, size: z.number().int().positive() }))
    .min(1)
    .max(LIMITS.maxPresignItems),
});

/** Controls (design §6.7, §8.3). Spawn is not a message. */
export const killHalf = z.object({ t: z.literal("killHalf"), ...envelope });
export const freezeHalf = z.object({ t: z.literal("freezeHalf"), ...envelope });
export const throttleHalf = z.object({ t: z.literal("throttleHalf"), ...envelope });
export const resumeAll = z.object({ t: z.literal("resumeAll"), ...envelope });
/** Stop: end the running execution, drop the loop's queued continuations, hold the loop (WP6.1). */
export const stop = z.object({ t: z.literal("stop"), ...envelope });
/** Start: let the loop run again after a stop. */
export const start = z.object({ t: z.literal("start"), ...envelope });
/**
 * Pause (WP6.4): nothing new is assigned or started while the sender's socket lives; in-flight
 * tasks finish. Resume, or the sender going away, lifts it.
 */
export const pause = z.object({ t: z.literal("pause"), ...envelope });
export const resume = z.object({ t: z.literal("resume"), ...envelope });
export const restart = z.object({ t: z.literal("restart"), ...envelope });
export const skip = z.object({ t: z.literal("skip"), ...envelope });
export const killExecution = z.object({ t: z.literal("killExecution"), ...envelope, executionId });
export const launch = z.object({
  t: z.literal("launch"),
  ...envelope,
  bundle: hash,
  params,
  inherit: z
    .union([executionId, z.literal("latest")])
    .nullable()
    .default(null),
});
export const runFollowUp = z.object({ t: z.literal("runFollowUp"), ...envelope, executionId });
export const setRedundancy = z.object({
  t: z.literal("setRedundancy"),
  ...envelope,
  on: z.boolean(),
});

export const observerToControlPlane = z.discriminatedUnion("t", [
  subscribe,
  ping,
  observerPresign,
  killHalf,
  freezeHalf,
  throttleHalf,
  resumeAll,
  stop,
  start,
  pause,
  resume,
  restart,
  skip,
  killExecution,
  launch,
  runFollowUp,
  setRedundancy,
]);

/** Control plane → observer. */
export const machineView = z.object({
  awake: z.boolean(),
  reason: z.string().max(128).nullable(),
  redundancy: z.boolean(),
  /** A person pressed Stop: the loop waits for Start (WP6.1). Absent means no. */
  stopped: z.boolean().optional(),
  /** An editor tab holds the machine paused (WP6.4). Absent means no. */
  paused: z.boolean().optional(),
  /** Next scheduled rotation, when known. */
  nextRotationAt: millis.nullable(),
  uptimeMs: millis,
});

/** A program the machine can launch (design §5.1); the seeded demos and every upload since. */
export const programView = z.object({
  bundle: hash,
  name: z.string().min(1).max(64),
  view: z.enum(["tiles", "bars", "text"]),
  description: z.string().max(512).nullable(),
  defaultParams: params,
  addedAt: millis,
});

export const snapshot = z.object({
  t: z.literal("snapshot"),
  ...envelope,
  seq,
  page: z.number().int().nonnegative(),
  pages: z.number().int().min(1),
  /** Present on page 0 only. */
  nodes: z.array(nodeView).optional(),
  programs: z.array(programView).optional(),
  execution: executionView.nullable().optional(),
  queue: z.array(queueEntry).optional(),
  machine: machineView.optional(),
  /** Task rows, paged by LIMITS.snapshotPageTasks. */
  tasks: z.array(taskView).max(LIMITS.snapshotPageTasks).default([]),
  /** Wall-clock of the control plane when the snapshot was taken. */
  at: millis,
});

export const pong = z.object({ t: z.literal("pong"), ...envelope, seq });

export const error = z.object({
  t: z.literal("error"),
  ...envelope,
  code: z.string().min(1).max(64),
  message: z.string().max(1024),
});

export const observerPresigned = z.object({
  t: z.literal("presigned"),
  ...envelope,
  urls: z.array(
    z.object({
      hash,
      url: z.string().url().or(z.string().startsWith("/")).nullable(),
      headers: z.record(z.string(), z.string()),
    }),
  ),
});

const event = { ...envelope, seq };

export const nodeJoined = z.object({ t: z.literal("nodeJoined"), ...event, node: nodeView });
export const nodeLeft = z.object({
  t: z.literal("nodeLeft"),
  ...event,
  nodeId,
  reason: z.enum(["closed", "silent", "rotating"]),
});
export const nodeHealth = z.object({ t: z.literal("nodeHealth"), ...event, nodeId, health });

export const executionQueued = z.object({
  t: z.literal("executionQueued"),
  ...event,
  entry: queueEntry,
});
export const executionStarted = z.object({
  t: z.literal("executionStarted"),
  ...event,
  execution: executionView,
});
export const stageStarted = z.object({
  t: z.literal("stageStarted"),
  ...event,
  executionId,
  stage: z.number().int().nonnegative(),
  name: z.string().max(64),
  taskCount: z.number().int().positive(),
  canvas: z.object({ w: z.number().int().positive(), h: z.number().int().positive() }).nullable(),
  tasks: z.array(taskView).max(LIMITS.snapshotPageTasks).default([]),
});
export const stageDone = z.object({
  t: z.literal("stageDone"),
  ...event,
  executionId,
  stage: z.number().int().nonnegative(),
  root: hash,
});
export const executionDone = z.object({
  t: z.literal("executionDone"),
  ...event,
  executionId,
  root: hash.nullable(),
  followUp: params.nullable(),
});
/** Something an operator should see that did not stop the execution (design §5.4). */
export const executionWarning = z.object({
  t: z.literal("executionWarning"),
  ...event,
  executionId,
  code: z.enum(["expired-root"]),
  message: z.string().max(1024),
});
export const executionFailed = z.object({
  t: z.literal("executionFailed"),
  ...event,
  executionId,
  reason: z.string().max(1024),
});
export const budget = z.object({
  t: z.literal("budget"),
  ...event,
  executionId,
  computeMsUsed: millis,
  computeMsCap: millis,
});

export const taskAssigned = z.object({
  t: z.literal("taskAssigned"),
  ...event,
  taskId,
  nodeId,
  attempt: z.number().int().min(1),
});
export const taskDone = z.object({
  t: z.literal("taskDone"),
  ...event,
  taskId,
  nodeId,
  output: hash,
  place: place.nullable(),
  computeMs: millis,
  /** Present once the control plane forwards the accepted result's log (dashboard v2). */
  log: taskLog.optional(),
});
export const taskReassigned = z.object({
  t: z.literal("taskReassigned"),
  ...event,
  taskId,
  fromNode: nodeId,
});
export const taskSpeculated = z.object({
  t: z.literal("taskSpeculated"),
  ...event,
  taskId,
  nodeId,
});
export const taskVerified = z.object({ t: z.literal("taskVerified"), ...event, taskId, nodeId });
export const taskMismatch = z.object({ t: z.literal("taskMismatch"), ...event, taskId, nodeId });
export const taskFailed = z.object({
  t: z.literal("taskFailed"),
  ...event,
  taskId,
  reason: z.string().max(1024),
});

export const controlApplied = z.object({
  t: z.literal("controlApplied"),
  ...event,
  op: z.enum([
    "killHalf",
    "freezeHalf",
    "throttleHalf",
    "resumeAll",
    "restart",
    "skip",
    "killExecution",
    "setRedundancy",
    "stop",
    "start",
    "pause",
    "resume",
  ]),
  nodeIds: z.array(nodeId).default([]),
});
export const programAdded = z.object({
  t: z.literal("programAdded"),
  ...event,
  program: hash,
  name: z.string().min(1).max(64),
});
/** A newer bundle shipped under this name; the old one leaves the list (WP4.9). */
export const programRetired = z.object({
  t: z.literal("programRetired"),
  ...event,
  program: hash,
  name: z.string().min(1).max(64),
});
export const controlPlaneRotating = z.object({
  t: z.literal("controlPlaneRotating"),
  ...event,
  next: z.number().int().nonnegative(),
  reconnectAfterMs: millis,
});
export const machineSleeping = z.object({
  t: z.literal("machineSleeping"),
  ...event,
  reason: z.string().max(128),
});

export const controlPlaneToObserver = z.discriminatedUnion("t", [
  snapshot,
  pong,
  error,
  observerPresigned,
  nodeJoined,
  nodeLeft,
  nodeHealth,
  executionQueued,
  executionStarted,
  stageStarted,
  stageDone,
  executionDone,
  executionFailed,
  executionWarning,
  budget,
  taskAssigned,
  taskDone,
  taskReassigned,
  taskSpeculated,
  taskVerified,
  taskMismatch,
  taskFailed,
  controlApplied,
  programAdded,
  programRetired,
  controlPlaneRotating,
  machineSleeping,
]);

export type Subscribe = z.infer<typeof subscribe>;
export type Ping = z.infer<typeof ping>;
export type Snapshot = z.infer<typeof snapshot>;
export type ProgramView = z.infer<typeof programView>;
export type Pong = z.infer<typeof pong>;
export type ErrorMessage = z.infer<typeof error>;
export type MachineView = z.infer<typeof machineView>;
export type NodeJoined = z.infer<typeof nodeJoined>;
export type NodeLeft = z.infer<typeof nodeLeft>;
export type NodeHealth = z.infer<typeof nodeHealth>;
export type ObserverToControlPlane = z.infer<typeof observerToControlPlane>;
export type ControlPlaneToObserver = z.infer<typeof controlPlaneToObserver>;
export type ObserverEvent = Exclude<
  ControlPlaneToObserver,
  Snapshot | Pong | ErrorMessage | z.infer<typeof observerPresigned>
>;
export type Control = Exclude<
  ObserverToControlPlane,
  Subscribe | Ping | z.infer<typeof observerPresign>
>;
