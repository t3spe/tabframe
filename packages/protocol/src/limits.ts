/** Wire-level limits (design §8.4). Both ends enforce them. */
export const PROTOCOL_VERSION = 1;

export const LIMITS = {
  /** Every socket message stays under this many UTF-8 bytes. */
  maxMessageBytes: 64 * 1024,
  /** A task's inline input, base64, before it must become a blob instead. */
  maxInlineInputBytes: 16 * 1024,
  /** Tasks per snapshot page. */
  snapshotPageTasks: 256,
  /** Cluster caps (decision: 256 nodes, 64 observers, no per-IP limit). */
  nodeCap: 256,
  observerCap: 64,
  /** Liveness. */
  heartbeatMs: 1_000,
  goneAfterMs: 4_000,
  observerPingMs: 2_000,
  maxInFlight: 2,
  /**
   * Rate limits, messages per second per connection. A node sends a presign and a result per
   * task, and a tile takes a few milliseconds, so an honest node reaches hundreds per second.
   */
  nodeMessagesPerSecond: 1_000,
  observerMessagesPerSecond: 5,
  /** Results and uploads (design §5.5, §8.4). */
  maxWriteFiles: 256,
  maxWriteBytes: 16 * 1024 * 1024,
  maxOutputBytes: 16 * 1024 * 1024,
  maxLogBytes: 64 * 1024,
  maxInlineLogBytes: 4 * 1024,
  /** Items per presign, sized so a `presigned` reply of signed URLs (about 2 KB each) fits one frame (WP8.2). */
  maxPresignItems: 24,
  maxModuleBytes: 8 * 1024 * 1024,
  /** Reconnect backoff window. */
  reconnectMinMs: 500,
  reconnectMaxMs: 30_000,
} as const;
