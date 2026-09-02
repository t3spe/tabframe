import { LIMITS } from "@tabframe/protocol";

/** Exponential backoff with full jitter between the protocol's reconnect bounds. */
export class Backoff {
  private attempt = 0;
  private readonly rng: () => number;

  constructor(rng: () => number = Math.random) {
    this.rng = rng;
  }

  next(): number {
    const cap = Math.min(LIMITS.reconnectMaxMs, LIMITS.reconnectMinMs * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 10);
    return Math.floor(
      LIMITS.reconnectMinMs + this.rng() * Math.max(0, cap - LIMITS.reconnectMinMs),
    );
  }

  reset(): void {
    this.attempt = 0;
  }
}
