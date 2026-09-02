/**
 * The seams between the pure core and the world. The control-plane process, the local dev
 * server, and the tests each provide their own implementations.
 */

/** Wall clock in milliseconds. Injected so tests and the simulation run on virtual time. */
export interface Clock {
  now(): number;
}

/** Uniform random in [0, 1). Injected so victim selection and jitter are replayable by seed. */
export interface Rng {
  next(): number;
}

/** Delivers effects to connections. Implemented over real sockets by the process. */
export interface Transport {
  send(connId: string, text: string): void;
  close(connId: string, code: number, reason: string): void;
}

/** Content-addressed blob store (design §7.1). Bytes in, hash out; URL for a hash. */
export interface Store {
  put(bytes: Uint8Array): Promise<string>;
  url(hash: string): string;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Deterministic PRNG (mulberry32) for tests and the simulation. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}
