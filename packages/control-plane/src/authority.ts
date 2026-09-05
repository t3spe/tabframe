import type { Inflight } from "./inflight.ts";
import type { Log } from "./log.ts";

/** How often a standby control plane asks the pointer whether it is named. */
export const AUTHORITY_POLL_MS = 5_000;

/** What the fleet's pointer says: the active control plane and its generation (design §9.2). */
export interface Pointer {
  microvmId: string | null;
  generation: number;
}

export type PointerReader = () => Promise<Pointer>;

export type LeaseVerdict =
  | { kind: "unchecked" }
  | { kind: "unknown"; error: unknown }
  | { kind: "checked"; superseded: boolean; pointer: number };

export interface Authority {
  /** Whether this control plane may launch cores and write `latest`. */
  readonly authoritative: boolean;
  /** Poll the pointer until it names this process; a handover adopted into it settles it sooner. */
  awaitNaming(): void;
  /** Named by the pointer, or handed a ledger: from here on this control plane acts. */
  grant(how: string): void;
  /** Whether the pointer names another, newer control plane: the question a lease expiry asks. */
  supersededBy(generation: number): Promise<LeaseVerdict>;
  stop(): void;
}

export interface AuthorityDeps {
  /** Null where there is no pointer (a laptop, most tests): the process is authoritative at once. */
  readPointer: PointerReader | null;
  self: () => string | null;
  onGranted: () => void;
  inflight: Inflight;
  log: Log;
  pollMs?: number;
}

/**
 * Standby until named (design §9.4): a successor is a control plane from /run, but it launches no
 * cores and writes no `latest` until the pointer names it or a handover is adopted into it —
 * before that, a rotation that dies leaves nothing of it behind but itself.
 */
export function createAuthority(deps: AuthorityDeps): Authority {
  const { readPointer, log } = deps;
  let authoritative = readPointer === null;
  let timer: ReturnType<typeof setInterval> | null = null;

  function grant(how: string): void {
    if (authoritative) return;
    authoritative = true;
    if (timer) clearInterval(timer);
    timer = null;
    log("authoritative", { how });
    deps.onGranted();
  }

  return {
    get authoritative() {
      return authoritative;
    },
    awaitNaming() {
      if (authoritative || !readPointer || timer) return;
      const check = () =>
        deps.inflight.track(
          readPointer()
            .then((p) => {
              if (p.microvmId !== null && p.microvmId === deps.self()) grant("pointer");
            })
            .catch((err) => log("authority-check-failed", { error: String(err) })),
        );
      check();
      timer = setInterval(check, deps.pollMs ?? AUTHORITY_POLL_MS);
    },
    grant,
    async supersededBy(generation) {
      if (!readPointer) return { kind: "unchecked" };
      let named: Pointer;
      try {
        named = await readPointer();
      } catch (error) {
        return { kind: "unknown", error };
      }
      const superseded =
        named.microvmId !== null &&
        named.microvmId !== deps.self() &&
        named.generation > generation;
      return { kind: "checked", superseded, pointer: named.generation };
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
