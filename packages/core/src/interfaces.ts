// The seams between the pure core and the world: time and randomness are parameters, so tests and
// the simulation run on virtual time and replay by seed.

/** Wall clock in milliseconds. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Deterministic PRNG (mulberry32): uniform in [0, 1), the shape `apply` and `drain` take. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
