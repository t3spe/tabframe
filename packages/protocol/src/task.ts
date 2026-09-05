import { z } from "zod";
import { LIMITS } from "./limits.ts";
import {
  canvas,
  executionId,
  hash,
  millis,
  nodeId,
  programName,
  taskId,
  viewKind,
} from "./shared.ts";

export const taskKind = z.enum(["run", "plan"]);
export const taskStatus = z.enum(["pending", "assigned", "done", "failed"]);
export const executionStatus = z.enum(["queued", "running", "done", "failed", "cancelled"]);
/** `viewKind` under its older name. */
export const view = viewKind;

export const place = z.object({
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
});
export type PlaceView = z.infer<typeof place>;

export const params = z.record(z.string(), z.unknown());

/** A task's log as the node reported it: inline up to the cap, a blob beyond (design §8.2). */
export const taskLog = z
  .union([z.object({ hash }), z.object({ text: z.string().max(LIMITS.maxInlineLogBytes) })])
  .nullable();
export type TaskLog = z.infer<typeof taskLog>;

/** What observers see about a task (design §6.2, §8.3). */
export const taskView = z.object({
  taskId,
  executionId,
  stage: z.number().int().nonnegative(),
  index: z.number().int().nonnegative(),
  kind: taskKind,
  status: taskStatus,
  /** Nodes with an open attempt; two means a speculative twin. */
  holders: z.array(nodeId).max(2),
  attempts: z.number().int().nonnegative(),
  output: hash.nullable(),
  place: place.nullable(),
  contested: z.boolean(),
  /** The accepted result's log, once the control plane carries it. */
  log: taskLog.optional(),
});
export type TaskView = z.infer<typeof taskView>;

export const counters = z.object({
  pending: z.number().int().nonnegative(),
  assigned: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  reassigned: z.number().int().nonnegative(),
  speculated: z.number().int().nonnegative(),
  verified: z.number().int().nonnegative(),
  mismatched: z.number().int().nonnegative(),
});
export type Counters = z.infer<typeof counters>;

export const executionView = z.object({
  executionId,
  program: hash,
  programName,
  status: executionStatus,
  /** Why it ended, when it did not end well; "stopped by a person" after a Stop. */
  failure: z.string().max(512).nullable().optional(),
  human: z.boolean(),
  view: viewKind,
  params,
  stage: z.number().int().nonnegative(),
  stageName: z.string().max(64),
  taskCount: z.number().int().nonnegative(),
  canvas: canvas.nullable(),
  root: hash.nullable(),
  counters,
  startedAt: millis.nullable(),
});
export type ExecutionView = z.infer<typeof executionView>;

export const queueEntry = z.object({
  executionId,
  programName,
  /** The bundle hash: the editor matches its own launch on it, not on a name anyone may use. */
  bundle: hash.optional(),
  human: z.boolean(),
  queuedAt: millis,
});
export type QueueEntry = z.infer<typeof queueEntry>;

/** Per-task limits the sandbox enforces (design §5.5). */
export const taskLimits = z.object({
  maxOutputBytes: z.number().int().positive(),
  maxWriteBytes: z.number().int().positive(),
  maxWriteFiles: z.number().int().positive(),
  maxLogBytes: z.number().int().positive(),
  memoryPagesMax: z.number().int().positive(),
});
export type TaskLimits = z.infer<typeof taskLimits>;
