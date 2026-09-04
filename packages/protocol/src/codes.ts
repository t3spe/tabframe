/** WebSocket close codes in the application range (design §8.4). */
export const CLOSE = {
  /** The peer sent something that failed schema validation or the size cap. */
  invalidMessage: 4000,
  /** Protocol version mismatch; the page reloads itself once. */
  versionMismatch: 4001,
  /** The node cap is reached. */
  nodeCap: 4002,
  /** The connection exceeded its message rate. */
  rateLimited: 4003,
  /** The control plane declared this node gone (silence) and is hanging up on the zombie. */
  declaredGone: 4004,
  /** The control plane is rotating; reconnect through the session function after the jittered delay in the reason. */
  rotatingReconnect: 4005,
  /** The message carried another control plane's generation. */
  generationMismatch: 4006,
  /** The observer cap is reached. */
  observerCap: 4007,
  /** Every client connection the control plane keeps for clients is taken (WP8.2 cap; WP8.3 code). */
  machineFull: 4008,
} as const;

export type CloseCode = (typeof CLOSE)[keyof typeof CLOSE];

/** Reason payload for `rotatingReconnect`, JSON-encoded in the close reason (≤ 123 bytes). */
export interface RotatingReason {
  gen: number;
  next: number;
  reconnectAfterMs: number;
}
