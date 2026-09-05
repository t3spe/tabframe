// Launching a control plane: RunMicrovm with the design's payload and connectors, carried through
// throttling and token replays, then the wait for RUNNING.
import {
  CONTROL_PLANE_IDLE_POLICY,
  CONTROL_PLANE_MAX_DURATION_SECONDS,
  egressConnectorArn,
  ingressConnectorArn,
} from "../config.ts";
import { isThrottling, type MicrovmClient, type MicrovmInfo } from "../types.ts";
import type { RotateDeps } from "./index.ts";
import { terminateQuietly } from "./retire.ts";

/** The run-hook payload a control plane receives (design §9.3). Nothing fleet-related is in the image. */
export interface ControlPlanePayload {
  role: "control-plane";
  generation: number;
  snapshotKey: string | null;
  sessionUrl: string;
  storeBase: string;
  fleetSecret: string;
}

/** The account's RunMicrovm rate is one per second: throttling is expected and waited out. */
export const RUN_BACKOFF_MS = [1000, 2000, 4000, 8000];

export interface LaunchRequest {
  generation: number;
  secret: string;
  /** The operator's pin, kept in the pointer, wins over the function's environment. */
  pin: string | null;
  /** Runs as soon as the MicroVM exists, before the wait for RUNNING. */
  onLaunched?: (vm: MicrovmInfo) => Promise<void>;
}

type SnapshotDeps = Pick<RotateDeps, "snapshots" | "latestSnapshotKey">;
type LaunchDeps = Pick<RotateDeps, "microvms" | "clock" | "sleep" | "log" | "config"> &
  SnapshotDeps;

async function latestSnapshotKey(deps: SnapshotDeps): Promise<string | null> {
  if (deps.snapshots) return deps.snapshots.latestKey();
  return (await deps.latestSnapshotKey?.()) ?? null;
}

/** The payload for generation `generation`, naming the latest snapshot so it boots adopted. */
export async function buildPayload(
  deps: Pick<RotateDeps, "config"> & SnapshotDeps,
  generation: number,
  secret: string,
): Promise<ControlPlanePayload> {
  return {
    role: "control-plane",
    generation,
    snapshotKey: await latestSnapshotKey(deps),
    sessionUrl: deps.config.sessionUrl,
    storeBase: deps.config.storeBase,
    fleetSecret: secret,
  };
}

/** RunMicrovm, retried through the backoff schedule while the API throttles. */
export async function runWithBackoff(
  deps: Pick<RotateDeps, "microvms" | "sleep" | "log">,
  params: Parameters<MicrovmClient["run"]>[0],
): Promise<MicrovmInfo> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await deps.microvms.run(params);
    } catch (error) {
      const wait = RUN_BACKOFF_MS[attempt];
      if (!isThrottling(error) || wait === undefined) throw error;
      deps.log.warn("rotate: RunMicrovm throttled, backing off", { attempt, waitMs: wait });
      await deps.sleep.sleep(wait);
    }
  }
}

/**
 * One poll. A failed poll is a poll to repeat, not a reason to abandon a MicroVM that is booting:
 * abandoned, it runs to its ceiling with no record of it.
 */
async function pollOnce(
  deps: Pick<RotateDeps, "microvms" | "log">,
  microvmId: string,
): Promise<MicrovmInfo | null | "retry"> {
  let info: MicrovmInfo | null;
  try {
    info = await deps.microvms.get(microvmId);
  } catch (error) {
    deps.log.warn("rotate: polling the new control plane failed; polling again", {
      reason: String(error),
    });
    return "retry";
  }
  if (info?.state === "RUNNING") return info;
  if (!info || info.state === "TERMINATED" || info.state === "TERMINATING") return null;
  return "retry";
}

/** Poll until RUNNING; null when the MicroVM is gone or the ready timeout passes. */
export async function waitUntilRunning(
  deps: Pick<RotateDeps, "microvms" | "clock" | "sleep" | "log" | "config">,
  microvmId: string,
): Promise<MicrovmInfo | null> {
  const deadline = deps.clock.now() + deps.config.readyTimeoutMs;
  for (;;) {
    const polled = await pollOnce(deps, microvmId);
    if (polled !== "retry") return polled;
    if (deps.clock.now() >= deadline) return null;
    await deps.sleep.sleep(deps.config.pollIntervalMs);
  }
}

/**
 * Launch a control plane for the generation. Null when it never reached RUNNING (it is terminated:
 * left behind, it would block every later run of its generation and bill for hours). Throws when
 * RunMicrovm itself fails.
 */
export async function launchControlPlane(
  deps: LaunchDeps,
  req: LaunchRequest,
): Promise<MicrovmInfo | null> {
  const { config, log } = deps;
  const payload = await buildPayload(deps, req.generation, req.secret);
  // One control plane per generation and hour, however many rotations run at once. The API answers
  // a replayed token with the MicroVM it named the first time, state and all, so a token that
  // resolves to one already gone is retried with a numbered suffix, a few times.
  const hour = Math.floor(deps.clock.now() / 3_600_000);
  let launched: MicrovmInfo | null = null;
  for (let retry = 0; retry < 3 && !launched; retry++) {
    const candidate = await runWithBackoff(deps, {
      imageArn: config.imageArn,
      imageVersion: req.pin ?? config.imageVersion,
      executionRoleArn: config.controlPlaneRoleArn,
      runHookPayload: JSON.stringify(payload),
      ingressConnectors: [ingressConnectorArn(config.region)],
      egressConnectors: [egressConnectorArn(config.region)],
      idlePolicy: CONTROL_PLANE_IDLE_POLICY,
      maximumDurationInSeconds: CONTROL_PLANE_MAX_DURATION_SECONDS,
      clientToken: `tabframe-cp-g${req.generation}-${hour}${retry ? `-r${retry}` : ""}`,
    });
    if (candidate.state === "TERMINATED" || candidate.state === "TERMINATING") {
      log.warn("rotate: the client token replayed a MicroVM that is gone; retrying afresh", {
        microvmId: candidate.microvmId,
        retry,
      });
      continue;
    }
    launched = candidate;
  }
  if (!launched) return null;
  log.info("rotate: launched control plane", {
    microvmId: launched.microvmId,
    generation: req.generation,
    snapshotKey: payload.snapshotKey,
    imageVersion: launched.imageVersion,
  });
  await req.onLaunched?.(launched);
  let ready: MicrovmInfo | null = null;
  try {
    ready = await waitUntilRunning(deps, launched.microvmId);
  } catch (error) {
    log.warn("rotate: waiting for the new control plane failed", { reason: String(error) });
  }
  if (!ready) await terminateQuietly(deps, launched.microvmId, "never reached RUNNING");
  return ready;
}
