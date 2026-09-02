import { z } from "zod";
import { PROTOCOL_VERSION } from "./limits.ts";

/** Every message carries its type, the protocol version, and the control-plane generation. */
export const envelope = {
  v: z.literal(PROTOCOL_VERSION),
  gen: z.number().int().nonnegative(),
};

export const nodeId = z.string().min(1).max(64);
export const hostId = z.string().min(1).max(64);
export const hash = z.string().regex(/^[0-9a-f]{64}$/, "sha-256 hex");
export const seq = z.number().int().nonnegative();
export const millis = z.number().int().nonnegative();

export const nodeKind = z.enum(["tab", "core"]);
export type NodeKind = z.infer<typeof nodeKind>;

export const health = z.enum(["fast", "slow", "throttled", "gone"]);
export type Health = z.infer<typeof health>;

/** What observers see about a node. */
export const nodeView = z.object({
  nodeId,
  hostId,
  kind: nodeKind,
  health,
  visible: z.boolean(),
  tasksDone: z.number().int().nonnegative(),
  lastTaskMs: millis.nullable(),
  inFlight: z.number().int().nonnegative(),
  joinedAt: millis,
});
export type NodeView = z.infer<typeof nodeView>;
