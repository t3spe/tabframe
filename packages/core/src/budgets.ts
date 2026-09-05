// Token buckets and the budgets drawn on them (design §5.5, §8.4). A bucket refills continuously
// up to its cap, and a charge is all or nothing.
import { LIMITS } from "@tabframe/protocol";
import {
  CONTROL_COOLDOWN_MS,
  LAUNCHES_PER_MIN_MACHINE,
  PRESIGN_BYTES_PER_MIN,
  PRESIGN_BYTES_PER_MIN_MACHINE,
  PRESIGN_ITEMS_PER_MIN_MACHINE,
  SOLICITED_RATE,
} from "./policy.ts";

export interface Bucket {
  tokens: number;
  refilledAt: number;
}

/** A refill rate; the cap is also what a full bucket holds. */
export interface Rate {
  cap: number;
  refill(elapsedMs: number): number;
}

// The per-second and per-minute forms stay two expressions: they differ in the last bit of a
// refill, and a rate-limit decision at the boundary would move with it.
export const perSecond = (cap: number): Rate => ({ cap, refill: (ms) => (ms / 1000) * cap });
export const perMinute = (cap: number): Rate => ({ cap, refill: (ms) => (ms * cap) / 60_000 });

/** Every bucket the control plane keeps, by what it meters. */
export const BUDGETS = {
  /** What a node sends on its own initiative. */
  nodeMessages: perSecond(LIMITS.nodeMessagesPerSecond),
  observerMessages: perSecond(LIMITS.observerMessagesPerSecond),
  /** Results and presigns answer assignments, which maxInFlight already paces; this bounds a flood. */
  solicited: perSecond(SOLICITED_RATE),
  /** Presigned bytes, per connection. */
  presignBytes: perMinute(PRESIGN_BYTES_PER_MIN),
  /** Presign items and bytes for the whole machine. */
  machinePresignItems: perMinute(PRESIGN_ITEMS_PER_MIN_MACHINE),
  machinePresignBytes: perMinute(PRESIGN_BYTES_PER_MIN_MACHINE),
} as const;

/** A new bucket is full. */
export function newBucket(rate: Rate, now: number): Bucket {
  return { tokens: rate.cap, refilledAt: now };
}

function refill(b: Bucket, rate: Rate, now: number): void {
  b.tokens = Math.min(rate.cap, b.tokens + rate.refill(now - b.refilledAt));
  b.refilledAt = now;
}

/** Spend `n` tokens if they are there; false leaves the bucket refilled but unspent. */
export function take(b: Bucket, rate: Rate, now: number, n = 1): boolean {
  refill(b, rate, now);
  if (b.tokens < n) return false;
  b.tokens -= n;
  return true;
}

/**
 * Charge a presign against the connection's byte budget and the machine's item and byte budgets.
 * Nothing is spent unless all three afford it; the answer says which one refused.
 */
export function chargePresign(
  conn: { presignBytes: Bucket },
  machine: { presignItems: Bucket; presignBytesMachine: Bucket },
  items: Array<{ size: number }>,
  now: number,
): "ok" | "connection" | "machine" {
  let total = 0;
  for (const it of items) total += it.size;
  refill(conn.presignBytes, BUDGETS.presignBytes, now);
  refill(machine.presignItems, BUDGETS.machinePresignItems, now);
  refill(machine.presignBytesMachine, BUDGETS.machinePresignBytes, now);
  if (total > conn.presignBytes.tokens) return "connection";
  if (items.length > machine.presignItems.tokens) return "machine";
  if (total > machine.presignBytesMachine.tokens) return "machine";
  conn.presignBytes.tokens -= total;
  machine.presignItems.tokens -= items.length;
  machine.presignBytesMachine.tokens -= total;
  return "ok";
}

/**
 * Charge a launch against the observer's allowance and the machine's (design §5.5). The reason
 * when refused, null when the launch is counted.
 */
export function chargeLaunch(
  observer: { launchedAt: number[] },
  session: { launchesAt: number[] },
  perObserver: number,
  now: number,
): string | null {
  observer.launchedAt = observer.launchedAt.filter((at) => now - at < 60_000);
  if (observer.launchedAt.length >= perObserver) return `at most ${perObserver} launches a minute`;
  session.launchesAt = session.launchesAt.filter((at) => now - at < 60_000);
  if (session.launchesAt.length >= LAUNCHES_PER_MIN_MACHINE)
    return `the machine takes at most ${LAUNCHES_PER_MIN_MACHINE} launches a minute in all`;
  observer.launchedAt.push(now);
  session.launchesAt.push(now);
  return null;
}

/**
 * The machine-wide cooldown on a destructive control: how long ago it was last applied when that
 * is too recent, null when this application is stamped as the latest.
 */
export function coolingDown(
  lastControlAt: Record<string, number>,
  control: string,
  now: number,
): number | null {
  const last = lastControlAt[control] ?? 0;
  if (now - last < CONTROL_COOLDOWN_MS) return now - last;
  lastControlAt[control] = now;
  return null;
}
