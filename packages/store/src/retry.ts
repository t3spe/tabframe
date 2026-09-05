import { StoreError } from "./errors.ts";

/** One blob fetch may take this long: a fetch that never answers is a hung node, not a slow one. */
export const FETCH_TIMEOUT_MS = 15_000;
/** One upload attempt may take this long: a bound for a hang, wide enough for a 16 MB output on a slow link. */
export const UPLOAD_TIMEOUT_MS = 120_000;

export interface RetryPolicy {
  /** Attempts in all, the first included. */
  tries: number;
  /** The wait before the second attempt; each later wait doubles it. */
  baseMs: number;
  /** An attempt is abandoned after this long; the signal handed to it fires. */
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  retryable: (err: unknown) => boolean;
}

/** Network failures, timeouts, and 5xx / 429 answers are worth another go; nothing else is. */
export function transient(err: unknown): boolean {
  if (!(err instanceof StoreError)) return false;
  if (err.kind === "network" || err.kind === "timeout") return true;
  return err.kind === "http" && (err.status === 429 || (err.status ?? 0) >= 500);
}

/** Three tries with a short backoff: one S3 SlowDown must not fail everybody's frame. */
export const DEFAULT_RETRY: RetryPolicy = {
  tries: 3,
  baseMs: 250,
  timeoutMs: FETCH_TIMEOUT_MS,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  retryable: transient,
};

/** Run `attempt` under the policy; the last failure is thrown when the tries run out. */
export async function withRetries<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  policy: RetryPolicy,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt(AbortSignal.timeout(policy.timeoutMs));
    } catch (err) {
      if (i + 1 >= policy.tries || !policy.retryable(err)) throw err;
      await policy.sleep(policy.baseMs * 2 ** i);
    }
  }
}
