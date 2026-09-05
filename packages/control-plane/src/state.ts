import { apply, type Clock, type Effect, type Event, type Ledger } from "@tabframe/core";
import type { Role } from "./config.ts";

/** The rotation phase (design §9.4); neutral until the process is a control plane. */
export type Phase = "neutral" | "active" | "handing-over" | "drained";

/** Who this process is, decided once: by the /run hook in the image, at boot in local mode. */
export interface Identity {
  role: Exclude<Role, "neutral">;
  generation: number;
  microvmId: string | null;
  fleetSecret: string | null;
  sessionUrl: string | null;
}

export interface ProcessState {
  readonly identity: Identity | null;
  readonly role: Role;
  readonly generation: number;
  readonly sessionUrl: string | null;
  readonly fleetSecret: string | null;
  readonly microvmId: string | null;
  /** Present once the process is a control plane. */
  readonly ledger: Ledger | null;
  phase(): Phase;
  /** Take an identity; a second call is a programming error. */
  assume(identity: Identity): void;
  /** Fresh or adopted, this ledger is ours from here. */
  own(ledger: Ledger): void;
  /** Apply an event and execute its effects; nothing happens without a ledger or after close. */
  dispatch(event: Event): void;
  /** Execute effects that did not come from an event (an adopt, a drain). */
  execute(effects: Effect[]): void;
  /** Where effects go; the composition root binds the executor once it exists. */
  bind(execute: (effects: Effect[]) => void): void;
  /** No more dispatches: whatever is still in flight lands nowhere. */
  close(): void;
}

export function createProcessState(opts: {
  clock: Clock;
  generation: number;
  sessionUrl: string | null;
}): ProcessState {
  let identity: Identity | null = null;
  let ledger: Ledger | null = null;
  let closed = false;
  let execute: (effects: Effect[]) => void = () => {
    throw new Error("the process state has no effect executor yet");
  };
  return {
    get identity() {
      return identity;
    },
    get role() {
      return identity?.role ?? "neutral";
    },
    get generation() {
      return identity?.generation ?? opts.generation;
    },
    get sessionUrl() {
      return identity ? identity.sessionUrl : opts.sessionUrl;
    },
    get fleetSecret() {
      return identity?.fleetSecret ?? null;
    },
    get microvmId() {
      return identity?.microvmId ?? null;
    },
    get ledger() {
      return ledger;
    },
    phase() {
      return identity?.role === "control-plane" ? (ledger?.meta.phase ?? "active") : "neutral";
    },
    assume(next) {
      if (identity) throw new Error(`the role is already ${identity.role}`);
      identity = next;
    },
    own(next) {
      ledger = next;
    },
    dispatch(event) {
      if (!ledger || closed) return;
      execute(apply(ledger, event, opts.clock.now()));
    },
    execute(effects) {
      execute(effects);
    },
    bind(fn) {
      execute = fn;
    },
    close() {
      closed = true;
    },
  };
}
