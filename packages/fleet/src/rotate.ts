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

import {
  CONTROL_PLANE_IDLE_POLICY,
  CONTROL_PLANE_MAX_DURATION_SECONDS,
  egressConnectorArn,
  ingressConnectorArn,
  type RotateConfig,
} from "./config.ts";
import type { ControlPlaneClient, ControlPlaneTarget } from "./cp-client.ts";
import type { Pointer, PointerStore } from "./pointer.ts";
import {
  type Clock,
  isThrottling,
  type Logger,
  type MicrovmClient,
  type MicrovmInfo,
  SERVING_STATES,
  type SecretReader,
  type Sleeper,
} from "./types.ts";

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
  /** The latest ledger snapshot key, so a successor can adopt without its predecessor. */
  latestSnapshotKey?: () => Promise<string | null>;
}

export type RotateResult =
  | { action: "skipped-off" }
  | { action: "launched"; microvmId: string; generation: number; endpoint: string | null }
  | {
      action: "rotated";
      from: string;
      to: string;
      generation: number;
      endpoint: string | null;
      handedOver: boolean;
      drained: number;
    }
  | { action: "repaired"; microvmId: string; generation: number; endpoint: string | null }
  | { action: "failed"; reason: string };

/** The run-hook payload a control plane receives (design §9.3). Nothing fleet-related is in the image. */
export interface ControlPlanePayload {
  role: "control-plane";
  generation: number;
  snapshotKey: string | null;
  sessionUrl: string;
  storeBase: string;
  fleetSecret: string;
}

const RUN_BACKOFF_MS = [1000, 2000, 4000, 8000];
/** How long a drained control plane keeps its sockets before it is terminated. */
export const DRAIN_GRACE_MS = 5_000;

export type RotateHandler = (event?: unknown) => Promise<RotateResult>;

export function createRotateHandler(deps: RotateDeps): RotateHandler {
  const { pointer, microvms, secrets, clock, sleep, log, config } = deps;

  async function runWithBackoff(params: Parameters<MicrovmClient["run"]>[0]): Promise<MicrovmInfo> {
    // The account's RunMicrovm rate is one per second; throttling is expected and retried.
    for (let attempt = 0; ; attempt++) {
      try {
        return await microvms.run(params);
      } catch (error) {
        const wait = RUN_BACKOFF_MS[attempt];
        if (!isThrottling(error) || wait === undefined) throw error;
        log.warn("rotate: RunMicrovm throttled, backing off", { attempt, waitMs: wait });
        await sleep.sleep(wait);
      }
    }
  }

  async function waitUntilRunning(microvmId: string): Promise<MicrovmInfo | null> {
    const deadline = clock.now() + config.readyTimeoutMs;
    for (;;) {
      const info = await microvms.get(microvmId);
      if (info?.state === "RUNNING") return info;
      if (!info || info.state === "TERMINATED" || info.state === "TERMINATING") return null;
      if (clock.now() >= deadline) return null;
      await sleep.sleep(config.pollIntervalMs);
    }
  }

  /** Launch a control plane for `generation`, told where the latest snapshot is. */
  async function launch(generation: number, secret: string): Promise<MicrovmInfo | null> {
    const payload: ControlPlanePayload = {
      role: "control-plane",
      generation,
      snapshotKey: (await deps.latestSnapshotKey?.()) ?? null,
      sessionUrl: config.sessionUrl,
      storeBase: config.storeBase,
      fleetSecret: secret,
    };
    const launched = await runWithBackoff({
      imageArn: config.imageArn,
      imageVersion: config.imageVersion,
      executionRoleArn: config.controlPlaneRoleArn,
      runHookPayload: JSON.stringify(payload),
      ingressConnectors: [ingressConnectorArn(config.region)],
      egressConnectors: [egressConnectorArn(config.region)],
      idlePolicy: CONTROL_PLANE_IDLE_POLICY,
      maximumDurationInSeconds: CONTROL_PLANE_MAX_DURATION_SECONDS,
      // One control plane per generation, however many rotations run at once.
      clientToken: `tabframe-cp-g${generation}`,
    });
    log.info("rotate: launched control plane", {
      microvmId: launched.microvmId,
      generation,
      snapshotKey: payload.snapshotKey,
    });
    return await waitUntilRunning(launched.microvmId);
  }

  async function promote(
    p: Pointer,
    vm: MicrovmInfo,
    generation: number,
    now: number,
  ): Promise<void> {
    await pointer.write({
      ...p,
      state: "on",
      microvmId: vm.microvmId,
      endpoint: vm.endpoint,
      generation,
      imageVersion: vm.imageVersion,
      updatedAt: new Date(now).toISOString(),
      pending: null,
    });
  }

  async function terminateQuietly(microvmId: string, why: string): Promise<void> {
    try {
      await microvms.terminate(microvmId);
      log.info("rotate: terminated", { microvmId, why });
    } catch (error) {
      log.warn("rotate: terminate failed", { microvmId, why, reason: String(error) });
    }
  }

  /**
   * A previous run died between launching a successor and flipping the pointer. If that successor
   * is still serving, finish the job: promote it and retire the old one. If it is gone, forget it.
   */
  async function repair(p: Pointer, secret: string): Promise<RotateResult | null> {
    const stale = p.pending;
    if (!stale) return null;
    const vm = await microvms.get(stale.microvmId);
    if (!vm || !SERVING_STATES.has(vm.state)) {
      log.warn("rotate: forgetting a pending control plane that is gone", {
        microvmId: stale.microvmId,
        state: vm?.state ?? "not-found",
      });
      await pointer.write({ ...p, pending: null });
      return null;
    }
    if (stale.generation <= p.generation) {
      // The pointer already moved past it: this one lost the race.
      await terminateQuietly(stale.microvmId, "superseded");
      await pointer.write({ ...p, pending: null });
      return null;
    }
    log.info("rotate: finishing an interrupted rotation", {
      microvmId: stale.microvmId,
      generation: stale.generation,
    });
    const now = clock.now();
    const previous = p.microvmId;
    await promote(p, vm, stale.generation, now);
    if (previous && previous !== vm.microvmId) {
      await retire({ microvmId: previous, endpoint: p.endpoint ?? "" }, stale.generation, secret);
    }
    return {
      action: "repaired",
      microvmId: vm.microvmId,
      generation: stale.generation,
      endpoint: vm.endpoint,
    };
  }

  /** Drain a control plane's clients, then terminate it. Failures here never fail a rotation. */
  async function retire(target: ControlPlaneTarget, next: number, secret: string): Promise<number> {
    let drained = 0;
    const client = deps.controlPlane?.(secret);
    if (client && target.endpoint) {
      try {
        drained = (await client.drain(target, next)).drained;
        log.info("rotate: drained", { microvmId: target.microvmId, clients: drained });
      } catch (error) {
        log.warn("rotate: drain failed; terminating anyway", {
          microvmId: target.microvmId,
          reason: String(error),
        });
      }
    }
    await sleep.sleep(DRAIN_GRACE_MS);
    await terminateQuietly(target.microvmId, "rotated out");
    return drained;
  }

  return async () => {
    const p = await pointer.read();
    if (p.state === "off") {
      log.info("rotate: machine is off, nothing to do");
      return { action: "skipped-off" };
    }
    const secret = await secrets.read(config.fleetSecretArn);

    const repaired = await repair(p, secret);
    if (repaired) return repaired;
    const current = p.pending ? await pointer.read() : p;

    const running = current.microvmId ? await microvms.get(current.microvmId) : null;
    const serving = running && (SERVING_STATES.has(running.state) || running.state === "PENDING");

    // ---- nothing is serving: heal by launching one --------------------------------------------
    if (!serving) {
      if (current.microvmId) {
        log.warn("rotate: the pointer names a control plane that is gone", {
          microvmId: current.microvmId,
          state: running?.state ?? "not-found",
        });
      }
      const generation = current.generation + 1;
      let vm: MicrovmInfo | null;
      try {
        vm = await launch(generation, secret);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log.error("rotate: RunMicrovm failed", { reason });
        return { action: "failed", reason };
      }
      if (!vm) return { action: "failed", reason: "the control plane did not reach RUNNING" };
      await promote(current, vm, generation, clock.now());
      return {
        action: "launched",
        microvmId: vm.microvmId,
        generation,
        endpoint: vm.endpoint,
      };
    }

    // ---- a control plane is serving: rotate ----------------------------------------------------
    const generation = current.generation + 1;
    const old: ControlPlaneTarget = {
      microvmId: current.microvmId as string,
      endpoint: current.endpoint ?? running?.endpoint ?? "",
    };
    let next: MicrovmInfo | null;
    try {
      next = await launch(generation, secret);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.error("rotate: RunMicrovm failed", { reason });
      return { action: "failed", reason };
    }
    if (!next) return { action: "failed", reason: "the successor did not reach RUNNING" };
    // From here a crash is recoverable: the pending record names the successor.
    await pointer.write({
      ...current,
      pending: { microvmId: next.microvmId, endpoint: next.endpoint, generation },
    });

    const client = deps.controlPlane?.(secret);
    let handedOver = false;
    if (client) {
      try {
        const { ledger } = await client.handover(old);
        await client.adopt({ microvmId: next.microvmId, endpoint: next.endpoint ?? "" }, ledger);
        handedOver = true;
      } catch (error) {
        // The successor booted from the latest snapshot, at most five seconds stale, and every
        // task is idempotent — so a failed handover costs a little repeated work, not correctness.
        log.warn("rotate: handover failed; the successor keeps its snapshot state", {
          reason: String(error),
        });
      }
    }

    await promote(current, next, generation, clock.now());
    const drained = await retire(old, generation, secret);
    log.info("rotate: rotated", { from: old.microvmId, to: next.microvmId, generation });
    return {
      action: "rotated",
      from: old.microvmId,
      to: next.microvmId,
      generation,
      endpoint: next.endpoint,
      handedOver,
      drained,
    };
  };
}
