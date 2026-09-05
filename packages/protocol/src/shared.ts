import { z } from "zod";
import { LIMITS, PROTOCOL_VERSION } from "./limits.ts";

/** Every message carries its type, the protocol version, and the control-plane generation. */
export const envelope = {
  v: z.literal(PROTOCOL_VERSION),
  gen: z.number().int().nonnegative(),
};

/** The one identifier shape: nodes, hosts, tasks, executions, and program names are 1..64 characters. */
export const id = z.string().min(1).max(64);
export const nodeId = id;
export const hostId = id;
export const taskId = id;
export const executionId = id;
export const programName = id;
export const hash = z.string().regex(/^[0-9a-f]{64}$/, "sha-256 hex");
export const seq = z.number().int().nonnegative();
export const millis = z.number().int().nonnegative();

/** Where blobs are fetched from: an absolute URL, or a path on the page's own origin. */
export const storeUrl = z.string().url().or(z.string().startsWith("/"));

export const nodeKind = z.enum(["tab", "core"]);
export type NodeKind = z.infer<typeof nodeKind>;

export const health = z.enum(["fast", "slow", "throttled", "gone"]);
export type Health = z.infer<typeof health>;

/** How the dashboard draws a program's result (design §5.1). */
export const viewKind = z.enum(["tiles", "bars", "text"]);
export type ViewKind = z.infer<typeof viewKind>;

/** A stage's canvas for the tiles view, in pixels. */
export const canvas = z.object({ w: z.number().int().positive(), h: z.number().int().positive() });

/** The body of a presign request (design D18): the hashes to upload and their sizes. */
export const presignBody = {
  items: z
    .array(z.object({ hash, size: z.number().int().positive().max(LIMITS.maxOutputBytes) }))
    .min(1)
    .max(LIMITS.maxPresignItems),
};

/** The body of the reply: a signed URL per hash, null when the store already has the bytes. */
export const presignedBody = {
  urls: z.array(
    z.object({ hash, url: storeUrl.nullable(), headers: z.record(z.string(), z.string()) }),
  ),
};

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
