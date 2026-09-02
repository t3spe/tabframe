import { z } from "zod";
import { LIMITS } from "./limits.ts";
import { envelope, hostId, millis, nodeId, nodeKind } from "./shared.ts";

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

/** Control plane → node. */
export const welcome = z.object({
  t: z.literal("welcome"),
  ...envelope,
  nodeId,
  heartbeatMs: millis,
  maxInFlight: z.number().int().min(1).max(8),
  storeBase: z.string().url().or(z.string().startsWith("/")),
});

export const nodeToControlPlane = z.discriminatedUnion("t", [hello, heartbeat]);
export const controlPlaneToNode = z.discriminatedUnion("t", [welcome]);

export type Hello = z.infer<typeof hello>;
export type Heartbeat = z.infer<typeof heartbeat>;
export type Welcome = z.infer<typeof welcome>;
export type NodeToControlPlane = z.infer<typeof nodeToControlPlane>;
export type ControlPlaneToNode = z.infer<typeof controlPlaneToNode>;
