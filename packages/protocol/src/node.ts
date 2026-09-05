import { z } from "zod";
import { writeEntry } from "./fs.ts";
import { LIMITS } from "./limits.ts";
import {
  envelope,
  executionId,
  hash,
  hostId,
  millis,
  nodeId,
  nodeKind,
  presignBody,
  presignedBody,
  storeUrl,
  taskId,
} from "./shared.ts";
import { taskKind, taskLimits, taskLog } from "./task.ts";

/** Node → control plane. */
export const hello = z.object({
  t: z.literal("hello"),
  ...envelope,
  hostId,
  kind: nodeKind,
  cores: z.number().int().min(1).max(1024),
  sandboxVersion: z.string().min(1).max(32),
  /** A cloud core proves it is the MicroVM it names: the token its run payload carried. */
  coreToken: z.string().min(16).max(64).optional(),
});

export const heartbeat = z.object({
  t: z.literal("heartbeat"),
  ...envelope,
  visible: z.boolean(),
  queue: z.number().int().min(0).max(LIMITS.maxInFlight),
  lastTaskMs: millis.nullable(),
  tasksDone: z.number().int().nonnegative(),
});

/**
 * The error string a node sends when it gave up on a task at its own deadline (design §4.2): not a
 * program fault, so the control plane releases the attempt instead of failing the task.
 */
export const RELEASED = "released";

/** A result names hashes the store vouches for; the error form carries a message instead (design §8.2). */
export const result = z
  .object({
    t: z.literal("result"),
    ...envelope,
    taskId,
    attempt: z.number().int().min(1),
    output: hash.optional(),
    /** Byte length of the output blob, for the filesystem manifest entry. */
    outputSize: z.number().int().nonnegative().optional(),
    error: z.string().min(1).max(1024).optional(),
    writes: z.array(writeEntry).max(LIMITS.maxWriteFiles).default([]),
    log: taskLog.default(null),
    computeMs: millis,
  })
  .refine((r) => (r.output === undefined) !== (r.error === undefined), {
    message: "exactly one of output or error",
  })
  .refine((r) => r.output === undefined || r.outputSize !== undefined, {
    message: "outputSize accompanies output",
  });

/** Ask for presigned upload URLs for these hashes (design D18). */
export const presign = z.object({ t: z.literal("presign"), ...envelope, ...presignBody });

export const nodeToControlPlane = z.discriminatedUnion("t", [hello, heartbeat, result, presign]);

/** Control plane → node. */
export const welcome = z.object({
  t: z.literal("welcome"),
  ...envelope,
  nodeId,
  heartbeatMs: millis,
  maxInFlight: z.number().int().min(1).max(8),
  storeBase: storeUrl,
});

export const assign = z.object({
  t: z.literal("assign"),
  ...envelope,
  taskId,
  attempt: z.number().int().min(1),
  executionId,
  program: hash,
  kind: taskKind,
  stage: z.number().int().nonnegative(),
  index: z.number().int().nonnegative(),
  count: z.number().int().positive(),
  /** Inline input, base64. */
  input: z.string().max(Math.ceil((LIMITS.maxInlineInputBytes * 4) / 3) + 4),
  fsRoot: hash.nullable(),
  deadlineMs: millis,
  limits: taskLimits,
});

export const cancel = z.object({ t: z.literal("cancel"), ...envelope, taskId });

export const command = z.object({
  t: z.literal("command"),
  ...envelope,
  op: z.enum(["close", "freeze", "throttle", "resume"]),
});

export const presigned = z.object({ t: z.literal("presigned"), ...envelope, ...presignedBody });

export const controlPlaneToNode = z.discriminatedUnion("t", [
  welcome,
  assign,
  cancel,
  command,
  presigned,
]);

export type Hello = z.infer<typeof hello>;
export type Heartbeat = z.infer<typeof heartbeat>;
export type Result = z.infer<typeof result>;
export type Presign = z.infer<typeof presign>;
export type Welcome = z.infer<typeof welcome>;
export type Assign = z.infer<typeof assign>;
export type Cancel = z.infer<typeof cancel>;
export type Command = z.infer<typeof command>;
export type Presigned = z.infer<typeof presigned>;
export type NodeToControlPlane = z.infer<typeof nodeToControlPlane>;
export type ControlPlaneToNode = z.infer<typeof controlPlaneToNode>;
