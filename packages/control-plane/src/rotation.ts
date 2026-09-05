import { beginHandover, type Clock, deserializeLedger, drain, type Ledger } from "@tabframe/core";
import type { Authority } from "./authority.ts";
import type { Lifecycle } from "./lifecycle.ts";
import type { Log } from "./log.ts";
import type { SnapshotWriter } from "./snapshot-policy.ts";
import type { SocketGateway } from "./sockets.ts";
import type { ProcessState } from "./state.ts";

/** A serialized ledger: tasks carry base64 inputs, so it is bigger than the blob cap. */
export const MAX_LEDGER_BYTES = 64 * 1024 * 1024;

export type HandoverOutcome =
  | { kind: "no-ledger" }
  | { kind: "drained" }
  | { kind: "handed-over"; generation: number; json: string };

export type AdoptOutcome =
  | { kind: "unreadable" }
  | { kind: "newer"; theirs: number; ours: number }
  | { kind: "repeated"; generation: number }
  | { kind: "adopted"; generation: number };

export type DrainOutcome =
  | { kind: "no-ledger" }
  | { kind: "drained"; drained: number; next: number };

/** The rotation steps this process takes part in (design §9.4); the fleet drives them over HTTP. */
export interface Rotation {
  /** Step 2: stop assigning, pause intake, hand the ledger over. */
  handover(): Promise<HandoverOutcome>;
  /** Step 3: become the active control plane with the ledger the previous one handed over. */
  adopt(json: string): Promise<AdoptOutcome>;
  /** Step 5: let every client go with a jittered reconnect delay (design §8.4). */
  drain(next: number | null): Promise<DrainOutcome>;
  /** The handover lease ran out: ask the pointer before carrying on, and step aside if superseded. */
  leaseExpired(): Promise<void>;
}

export interface RotationDeps {
  state: ProcessState;
  gateway: Pick<SocketGateway, "closeAll">;
  snapshots: SnapshotWriter;
  authority: Authority;
  lifecycle: Lifecycle;
  /** The store base a handed-over ledger gets when it names none. */
  storeBase: string;
  rng: () => number;
  clock: Clock;
  log: Log;
}

export function createRotation(deps: RotationDeps): Rotation {
  const { state, gateway, snapshots, authority, lifecycle, clock, log } = deps;
  let adoptedOnce = false;

  /** The core's drain effects, then every client closed with the rotating code; how many went. */
  function letClientsGo(ledger: Ledger, next: number): number {
    const clients = ledger.conns.size;
    state.execute(drain(ledger, next, deps.rng));
    gateway.closeAll(1001, "rotating");
    return clients;
  }

  return {
    async handover() {
      const ledger = state.ledger;
      if (!ledger || state.role !== "control-plane") return { kind: "no-ledger" };
      // A drained control plane has let its clients go; a handover from it would resurrect a
      // generation that is over.
      if (ledger.meta.phase === "drained") return { kind: "drained" };
      const { json, generation } = beginHandover(ledger, clock.now());
      await snapshots.now("handover");
      log("handover", { generation, nodes: ledger.nodes.size, bytes: json.length });
      return { kind: "handed-over", generation, json };
    },

    async adopt(json) {
      let adopted: Ledger;
      try {
        adopted = deserializeLedger(json);
      } catch (err) {
        log("adopt-failed", { error: String(err) });
        return { kind: "unreadable" };
      }
      const ours = state.generation;
      // A ledger from a later generation would be a rollback; anything at or before ours is
      // either the handover we were launched for or a retry of it, and adopting twice is safe.
      if (adopted.meta.generation > ours) {
        log("adopt-refused", { theirs: adopted.meta.generation, ours });
        return { kind: "newer", theirs: adopted.meta.generation, ours };
      }
      const current = state.ledger;
      if (state.role === "control-plane" && current && adoptedOnce) {
        // A retried adopt after this process already took a handover: swapping the ledger under
        // live sockets would orphan them and roll the machine back, so the first adopt stands. A
        // successor that booted from a snapshot has taken none yet and takes this one.
        log("adopt-repeat", { generation: ours, ours: current.meta.seq, theirs: adopted.meta.seq });
        return { kind: "repeated", generation: ours };
      }
      lifecycle.becomeControlPlane(adopted.meta.storeBase || deps.storeBase, adopted);
      adoptedOnce = true;
      authority.grant("adopt");
      await lifecycle.seeded();
      state.dispatch({ kind: "tick" });
      log("adopt", { generation: ours, nodes: adopted.nodes.size });
      return { kind: "adopted", generation: ours };
    },

    async drain(wanted) {
      const ledger = state.ledger;
      if (!ledger || state.role !== "control-plane") return { kind: "no-ledger" };
      const next = wanted ?? state.generation + 1;
      const clients = letClientsGo(ledger, next);
      await snapshots.now("drain");
      log("drain", { next, clients });
      return { kind: "drained", drained: clients, next };
    },

    async leaseExpired() {
      const ledger = state.ledger;
      if (!ledger) {
        log("lease-expired", { checked: false });
        return;
      }
      const verdict = await authority.supersededBy(ledger.meta.generation);
      if (verdict.kind === "unchecked") {
        log("lease-expired", { checked: false });
        return;
      }
      if (verdict.kind === "unknown") {
        // Not knowing is not permission: the lease is re-armed and the question asked again.
        log("lease-expired", { checked: false, rearmed: true, error: String(verdict.error) });
        if (ledger.meta.phase === "active") beginHandover(ledger, clock.now());
        return;
      }
      log("lease-expired", {
        checked: true,
        superseded: verdict.superseded,
        pointer: verdict.pointer,
      });
      const now = state.ledger;
      if (!verdict.superseded || !now || now.meta.phase !== "active") return;
      const clients = letClientsGo(now, verdict.pointer);
      log("superseded", { by: verdict.pointer, clients, self: state.microvmId });
      const fleet = lifecycle.cores();
      if (state.microvmId && fleet) {
        await fleet
          .terminate(state.microvmId)
          .catch((err) => log("self-terminate-failed", { error: String(err) }));
      }
    },
  };
}

/** The `next` generation a drain body names, or null for none. */
export function parseNext(body: Uint8Array | null): number | null {
  if (!body || body.length === 0) return null;
  try {
    const v = (JSON.parse(new TextDecoder().decode(body)) as { next?: unknown }).next;
    return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
  } catch {
    return null;
  }
}
