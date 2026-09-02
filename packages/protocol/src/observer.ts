import { z } from "zod";
import { envelope, health, millis, nodeId, nodeView, seq } from "./shared.ts";

/** Observer → control plane. */
export const subscribe = z.object({
  t: z.literal("subscribe"),
  ...envelope,
  /** Last sequence number seen, when resubscribing after a gap. */
  since: seq.optional(),
});

export const ping = z.object({ t: z.literal("ping"), ...envelope });

export const observerToControlPlane = z.discriminatedUnion("t", [subscribe, ping]);

/** Control plane → observer. */
export const snapshot = z.object({
  t: z.literal("snapshot"),
  ...envelope,
  seq,
  page: z.number().int().nonnegative(),
  pages: z.number().int().min(1),
  nodes: z.array(nodeView),
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

const event = { ...envelope, seq };

export const nodeJoined = z.object({ t: z.literal("nodeJoined"), ...event, node: nodeView });
export const nodeLeft = z.object({
  t: z.literal("nodeLeft"),
  ...event,
  nodeId,
  reason: z.enum(["closed", "silent", "rotating"]),
});
export const nodeHealth = z.object({ t: z.literal("nodeHealth"), ...event, nodeId, health });

export const controlPlaneToObserver = z.discriminatedUnion("t", [
  snapshot,
  pong,
  error,
  nodeJoined,
  nodeLeft,
  nodeHealth,
]);

export type Subscribe = z.infer<typeof subscribe>;
export type Ping = z.infer<typeof ping>;
export type Snapshot = z.infer<typeof snapshot>;
export type Pong = z.infer<typeof pong>;
export type ErrorMessage = z.infer<typeof error>;
export type NodeJoined = z.infer<typeof nodeJoined>;
export type NodeLeft = z.infer<typeof nodeLeft>;
export type NodeHealth = z.infer<typeof nodeHealth>;
export type ObserverToControlPlane = z.infer<typeof observerToControlPlane>;
export type ControlPlaneToObserver = z.infer<typeof controlPlaneToObserver>;
export type ObserverEvent = NodeJoined | NodeLeft | NodeHealth;
