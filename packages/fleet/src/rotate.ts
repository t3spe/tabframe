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
  | { action: "skipped-recent" }
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
  | { action: "skipped-suspended" }
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

/** A scheduled rotation this soon after the last pointer change is skipped (WP6.7). */
export const RECENT_ROTATION_MS = 5 * 60 * 1000;

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
      // One control plane per generation and hour, however many rotations run at once (WP8.1: a
      // token fixed per generation kept resolving to a successor that never reached RUNNING).
      clientToken: `tabframe-cp-g${generation}-${Math.floor(clock.now() / 3_600_000)}`,
    });
    log.info("rotate: launched control plane", {
      microvmId: launched.microvmId,
      generation,
      snapshotKey: payload.snapshotKey,
    });
    const ready = await waitUntilRunning(launched.microvmId);
    if (!ready) {
      // A successor that never reached RUNNING is not left behind (WP8.1): it would block every
      // later run of the same generation and bill for hours.
      await terminateQuietly(launched.microvmId, "never reached RUNNING");
    }
    return ready;
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
    // WP6.7: a pending successor never adopted the current ledger — it booted from a snapshot of
    // its own and has been asleep with it since. While the current control plane still serves,
    // promoting the stale one would hand the dashboards an old, sleeping machine (seen as an
    // "asleep" banner at the start of a rotation, and a successor whose process was half an hour
    // old). Terminate it and rotate afresh from the live ledger instead; only a machine with
    // nothing else serving is worth finishing with.
    const running = p.microvmId ? await microvms.get(p.microvmId) : null;
    if (running && SERVING_STATES.has(running.state)) {
      log.warn("rotate: a pending successor with a stale ledger; terminating it, rotating afresh", {
        microvmId: stale.microvmId,
        generation: stale.generation,
      });
      await terminateQuietly(stale.microvmId, "stale pending successor");
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

  return async (event?: unknown) => {
    const p = await pointer.read();
    if (p.state === "off") {
      log.info("rotate: machine is off, nothing to do");
      return { action: "skipped-off" };
    }
    // WP6.7: the hourly rule must not race a rotation somebody just ran — two rotations at once
    // leave a pending successor behind. A scheduled invocation within five minutes of the last
    // pointer change is skipped; an operator's `mise run rotate` is not.
    const scheduled =
      typeof event === "object" &&
      event !== null &&
      (event as { source?: unknown }).source === "aws.events";
    const updatedAt = p.updatedAt ? Date.parse(p.updatedAt) : Number.NaN;
    if (scheduled && Number.isFinite(updatedAt) && clock.now() - updatedAt < RECENT_ROTATION_MS) {
      log.info("rotate: a rotation ran minutes ago; the scheduled one waits for the next hour", {
        ageMs: clock.now() - updatedAt,
      });
      return { action: "skipped-recent" };
    }
    const secret = await secrets.read(config.fleetSecretArn);

    const repaired = await repair(p, secret);
    if (repaired) return repaired;
    const current = p.pending ? await pointer.read() : p;

    const running = current.microvmId ? await microvms.get(current.microvmId) : null;
    const serving = running && (SERVING_STATES.has(running.state) || running.state === "PENDING");
    // A suspended control plane has nobody to serve (WP8.1): the scheduled rule leaves it be
    // instead of booting a fresh generation every hour of an idle night; the first visitor wakes
    // it and the next hour rotates it. An operator's rotate still rotates.
    if (scheduled && running?.state === "SUSPENDED") {
      log.info(
        "rotate: the control plane is suspended; the scheduled rotation waits for a visitor",
        {
          microvmId: running.microvmId,
        },
      );
      return { action: "skipped-suspended" };
    }

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
