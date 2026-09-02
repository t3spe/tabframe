import { z } from "zod";
import { fsPath } from "./fs.ts";
import { LIMITS } from "./limits.ts";
import { envelope, hash, hostId, millis, nodeId, nodeKind } from "./shared.ts";
import { taskKind, taskLimits } from "./task.ts";

/** Node → control plane. */
export const hello = z.object({
  t: z.literal("hello"),
  ...envelope,
  hostId,
  kind: nodeKind,
  cores: z.number().int().min(1).max(1024),
  sandboxVersion: z.string().min(1).max(32),
});

export const heartbeat = z.object({
  t: z.literal("heartbeat"),
  ...envelope,
  visible: z.boolean(),
  queue: z.number().int().min(0).max(LIMITS.maxInFlight),
  lastTaskMs: millis.nullable(),
  tasksDone: z.number().int().nonnegative(),
});

const writeEntry = z.object({ path: fsPath, hash, size: z.number().int().nonnegative() });

/** A result names hashes the store vouches for; the error form carries a message instead (design §8.2). */
export const result = z
  .object({
    t: z.literal("result"),
    ...envelope,
    taskId: z.string().min(1).max(64),
    attempt: z.number().int().min(1),
    output: hash.optional(),
    error: z.string().min(1).max(1024).optional(),
    writes: z.array(writeEntry).max(LIMITS.maxWriteFiles).default([]),
    log: z
      .union([z.object({ hash }), z.object({ text: z.string().max(LIMITS.maxInlineLogBytes) })])
      .nullable()
      .default(null),
    computeMs: millis,
  })
  .refine((r) => (r.output === undefined) !== (r.error === undefined), {
    message: "exactly one of output or error",
  });

/** Ask for presigned upload URLs for these hashes (design D18). */
export const presign = z.object({
  t: z.literal("presign"),
  ...envelope,
  items: z
    .array(z.object({ hash, size: z.number().int().positive() }))
    .min(1)
    .max(LIMITS.maxPresignItems),
});

export const nodeToControlPlane = z.discriminatedUnion("t", [hello, heartbeat, result, presign]);

/** Control plane → node. */
export const welcome = z.object({
  t: z.literal("welcome"),
  ...envelope,
  nodeId,
  heartbeatMs: millis,
  maxInFlight: z.number().int().min(1).max(8),
  storeBase: z.string().url().or(z.string().startsWith("/")),
});

export const assign = z.object({
  t: z.literal("assign"),
  ...envelope,
  taskId: z.string().min(1).max(64),
  attempt: z.number().int().min(1),
  executionId: z.string().min(1).max(64),
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

export const cancel = z.object({
  t: z.literal("cancel"),
  ...envelope,
  taskId: z.string().min(1).max(64),
});

export const command = z.object({
  t: z.literal("command"),
  ...envelope,
  op: z.enum(["close", "freeze", "throttle", "resume"]),
});

export const presigned = z.object({
  t: z.literal("presigned"),
  ...envelope,
  urls: z.array(
    z.object({
      hash,
      /** Absent when the store already has the bytes. */
      url: z.string().url().or(z.string().startsWith("/")).nullable(),
      headers: z.record(z.string(), z.string()),
    }),
  ),
});

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
