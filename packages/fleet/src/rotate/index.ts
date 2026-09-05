// The rotate function (design §9.4): the hourly handover, which is also the deploy path and the
// heal path. One run does at most one rotation and leaves the fleet in a state the next run can
// finish or roll back — an EventBridge schedule with no reserved concurrency can overlap runs, and
// a Lambda can die at any line.
//
//   1. launch CP(g+1), naming the latest snapshot so it boots adopted even if step 2 fails
//   2. CP(g) /handover  → its ledger
//   3. CP(g+1) /adopt   ← that ledger
//   4. flip the pointer
//   5. CP(g) /drain, then terminate after a grace period
import type { RotateConfig } from "../config.ts";
import type { ControlPlaneClient, ControlPlaneTarget } from "../cp-client.ts";
import type { Pointer, PointerStore } from "../pointer.ts";
import {
  type Clock,
  type Logger,
  type MicrovmClient,
  type MicrovmInfo,
  SERVING_STATES,
  type SecretReader,
  type Sleeper,
  type SnapshotIndex,
} from "../types.ts";
import { launchControlPlane } from "./launch.ts";
import { clearPending, clearRetiring, promote, recordPending } from "./pointer-ops.ts";
import { isScheduledEvent, type Skip, skipIfIdle, skipIfRecent } from "./policy.ts";
import { repair } from "./repair.ts";
import { retire } from "./retire.ts";

export { type ControlPlanePayload, RUN_BACKOFF_MS } from "./launch.ts";
export { PENDING_IN_PROGRESS_MS, RECENT_ROTATION_MS } from "./policy.ts";
export { DRAIN_GRACE_MS } from "./retire.ts";

export interface RotateDeps {
  pointer: PointerStore;
  microvms: MicrovmClient;
  secrets: SecretReader;
  clock: Clock;
  sleep: Sleeper;
  log: Logger;
  config: RotateConfig;
  /** Talks to a control plane's private port; built per run because it needs the fleet secret. */
  controlPlane?: (secret: string) => ControlPlaneClient;
  /** Names the latest ledger snapshot, so a successor can adopt without its predecessor. */
  snapshots?: SnapshotIndex;
  /** The older form of `snapshots`; packages/control-plane's handover test still passes it. */
  latestSnapshotKey?: () => Promise<string | null>;
}

export type RotateResult =
  | { action: "skipped-off" }
  | { action: "skipped-recent" }
  | { action: "in-progress"; microvmId: string; generation: number }
  | { action: "skipped-terminated" }
  | {
      action: "launched";
      microvmId: string;
      generation: number;
      endpoint: string | null;
      imageVersion: string | null;
    }
  | {
      action: "rotated";
      from: string;
      to: string;
      generation: number;
      endpoint: string | null;
      imageVersion: string | null;
      handedOver: boolean;
      drained: number;
    }
  | { action: "repaired"; microvmId: string; generation: number; endpoint: string | null }
  | { action: "skipped-suspended" }
  | { action: "failed"; reason: string };

export type RotateHandler = (event?: unknown) => Promise<RotateResult>;

/** A control plane worth rotating from: serving, or still booting. */
function isServing(vm: MicrovmInfo): boolean {
  return SERVING_STATES.has(vm.state) || vm.state === "PENDING";
}

/** The handler: read → stand down if scheduled and idle → finish a leftover retire → repair → heal or rotate. */
export function createRotateHandler(deps: RotateDeps): RotateHandler {
  const { pointer, microvms, secrets, clock, log, config } = deps;

  function skip(s: Skip): RotateResult {
    log.info(s.why, s.fields);
    return s.result;
  }

  /** Launch the successor, recorded as pending as soon as it exists; forgotten if it never comes up. */
  async function launchSuccessor(
    current: Pointer,
    generation: number,
    secret: string,
    notReady: string,
  ): Promise<{ vm: MicrovmInfo } | { failed: RotateResult }> {
    let vm: MicrovmInfo | null;
    try {
      vm = await launchControlPlane(deps, {
        generation,
        secret,
        pin: current.pinnedImageVersion ?? null,
        onLaunched: (launched) =>
          recordPending(pointer, current, launched, generation, clock.now()),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.error("rotate: RunMicrovm failed", { reason });
      return { failed: { action: "failed", reason } };
    }
    if (!vm) {
      await clearPending(pointer);
      return { failed: { action: "failed", reason: notReady } };
    }
    return { vm };
  }

  /**
   * Steps 2 and 3. A failed handover costs a little repeated work, not correctness: the successor
   * booted from the latest snapshot, at most five seconds stale, and every task is idempotent.
   */
  async function handOver(
    old: ControlPlaneTarget,
    next: MicrovmInfo,
    secret: string,
  ): Promise<boolean> {
    const client = deps.controlPlane?.(secret);
    if (!client) return false;
    try {
      const { ledger } = await client.handover(old);
      await client.adopt({ microvmId: next.microvmId, endpoint: next.endpoint ?? "" }, ledger);
      return true;
    } catch (error) {
      log.warn("rotate: handover failed; the successor keeps its snapshot state", {
        reason: String(error),
      });
      return false;
    }
  }

  /** Nothing is serving: launch one. */
  async function heal(
    current: Pointer,
    running: MicrovmInfo | null,
    secret: string,
  ): Promise<RotateResult> {
    if (current.microvmId) {
      log.warn("rotate: the pointer names a control plane that is gone", {
        microvmId: current.microvmId,
        state: running?.state ?? "not-found",
      });
    }
    const generation = current.generation + 1;
    const launched = await launchSuccessor(
      current,
      generation,
      secret,
      "the control plane did not reach RUNNING",
    );
    if ("failed" in launched) return launched.failed;
    const { vm } = launched;
    if (!(await promote(deps, current, vm, generation, clock.now())))
      return { action: "skipped-off" };
    return {
      action: "launched",
      microvmId: vm.microvmId,
      generation,
      endpoint: vm.endpoint,
      imageVersion: vm.imageVersion,
    };
  }

  /** A control plane is serving: the five steps. */
  async function rotateFrom(
    current: Pointer,
    old: ControlPlaneTarget,
    secret: string,
  ): Promise<RotateResult> {
    const generation = current.generation + 1;
    const launched = await launchSuccessor(
      current,
      generation,
      secret,
      "the successor did not reach RUNNING",
    );
    if ("failed" in launched) return launched.failed;
    const next = launched.vm;
    const handedOver = await handOver(old, next, secret);
    if (!(await promote(deps, current, next, generation, clock.now(), old))) {
      return { action: "skipped-off" };
    }
    const drained = await retire(deps, old, generation, secret);
    await clearRetiring(pointer);
    log.info("rotate: rotated", { from: old.microvmId, to: next.microvmId, generation });
    return {
      action: "rotated",
      from: old.microvmId,
      to: next.microvmId,
      generation,
      endpoint: next.endpoint,
      imageVersion: next.imageVersion,
      handedOver,
      drained,
    };
  }

  return async (event?: unknown) => {
    let p = await pointer.read();
    if (p.state === "off") {
      log.info("rotate: machine is off, nothing to do");
      return { action: "skipped-off" };
    }
    const scheduled = isScheduledEvent(event);
    if (scheduled) {
      const s = skipIfRecent(p, clock.now());
      if (s) return skip(s);
    }
    const secret = await secrets.read(config.fleetSecretArn);
    // A predecessor a dead rotation promoted over but never retired is finished first.
    if (p.retiring && p.retiring.microvmId !== p.microvmId) {
      log.warn("rotate: finishing the retire a previous run left behind", {
        microvmId: p.retiring.microvmId,
      });
      await retire(
        deps,
        { microvmId: p.retiring.microvmId, endpoint: p.retiring.endpoint ?? "" },
        p.generation,
        secret,
      );
      await clearRetiring(pointer);
      // The record read at the start still names the retiring predecessor; every write below spreads
      // the pointer it was given, so it must be the pointer as it is now.
      p = await pointer.read();
    }
    const repaired = await repair(deps, p, secret);
    if (repaired) return repaired;
    const current = p.pending ? await pointer.read() : p;
    const running = current.microvmId ? await microvms.get(current.microvmId) : null;
    if (scheduled) {
      const s = skipIfIdle(current, running);
      if (s) return skip(s);
    }
    if (!running || !current.microvmId || !isServing(running))
      return heal(current, running, secret);
    return rotateFrom(
      current,
      { microvmId: current.microvmId, endpoint: current.endpoint ?? running.endpoint ?? "" },
      secret,
    );
  };
}
