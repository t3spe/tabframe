// The rotate function, v0 (plan WP0.9): idempotent launch of a control plane when none is running.
// The hourly handover (design §9.4 steps 1–6) arrives in WP3.2; until then a running control plane
// is left alone and the TODO below marks the seam.
import {
  CONTROL_PLANE_IDLE_POLICY,
  CONTROL_PLANE_MAX_DURATION_SECONDS,
  egressConnectorArn,
  ingressConnectorArn,
  type RotateConfig,
} from "./config.ts";
import type { PointerStore } from "./pointer.ts";
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
}

export type RotateResult =
  | { action: "skipped-off" }
  | { action: "noop-running"; microvmId: string; generation: number }
  | { action: "launched"; microvmId: string; generation: number; endpoint: string | null }
  | { action: "failed"; reason: string };

/** The run-hook payload a control plane receives (design §9.3). Nothing fleet-related is baked into the image. */
export interface ControlPlanePayload {
  role: "control-plane";
  generation: number;
  snapshotKey: string | null;
  sessionUrl: string;
  storeBase: string;
  fleetSecret: string;
}

const RUN_BACKOFF_MS = [1000, 2000, 4000, 8000];

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
    while (true) {
      const info = await microvms.get(microvmId);
      if (info?.state === "RUNNING") return info;
      if (!info || info.state === "TERMINATED" || info.state === "TERMINATING") return null;
      if (clock.now() >= deadline) return null;
      await sleep.sleep(config.pollIntervalMs);
    }
  }

  return async () => {
    const p = await pointer.read();
    if (p.state === "off") {
      log.info("rotate: machine is off, nothing to do");
      return { action: "skipped-off" };
    }

    if (p.microvmId) {
      const current = await microvms.get(p.microvmId);
      if (current && (SERVING_STATES.has(current.state) || current.state === "PENDING")) {
        // TODO(WP3.2): hourly handover — launch g+1, /handover, /adopt, flip the pointer, /drain.
        log.info("rotate: control plane already running", { microvmId: p.microvmId });
        return { action: "noop-running", microvmId: p.microvmId, generation: p.generation };
      }
      log.warn("rotate: pointer names a control plane that is gone", {
        microvmId: p.microvmId,
        state: current?.state ?? "not-found",
      });
    }

    const generation = p.generation + 1;
    const payload: ControlPlanePayload = {
      role: "control-plane",
      generation,
      snapshotKey: null,
      sessionUrl: config.sessionUrl,
      storeBase: config.storeBase,
      fleetSecret: await secrets.read(config.fleetSecretArn),
    };

    let launched: MicrovmInfo;
    try {
      launched = await runWithBackoff({
        imageArn: config.imageArn,
        imageVersion: config.imageVersion,
        executionRoleArn: config.controlPlaneRoleArn,
        runHookPayload: JSON.stringify(payload),
        ingressConnectors: [ingressConnectorArn(config.region)],
        egressConnectors: [egressConnectorArn(config.region)],
        idlePolicy: CONTROL_PLANE_IDLE_POLICY,
        maximumDurationInSeconds: CONTROL_PLANE_MAX_DURATION_SECONDS,
        clientToken: `tabframe-cp-g${generation}`,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.error("rotate: RunMicrovm failed", { reason });
      return { action: "failed", reason };
    }
    log.info("rotate: launched control plane", { microvmId: launched.microvmId, generation });

    const ready = await waitUntilRunning(launched.microvmId);
    if (!ready) {
      log.error("rotate: control plane did not reach RUNNING", { microvmId: launched.microvmId });
      return {
        action: "failed",
        reason: `control plane ${launched.microvmId} did not reach RUNNING`,
      };
    }

    await pointer.write({
      state: "on",
      microvmId: ready.microvmId,
      endpoint: ready.endpoint ?? launched.endpoint,
      generation,
      imageVersion: ready.imageVersion ?? launched.imageVersion,
      updatedAt: new Date(clock.now()).toISOString(),
    });
    return {
      action: "launched",
      microvmId: ready.microvmId,
      generation,
      endpoint: ready.endpoint ?? launched.endpoint,
    };
  };
}
