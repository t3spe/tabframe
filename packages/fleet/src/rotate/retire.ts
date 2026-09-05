// Ending a control plane: drain its clients when there is a client to ask, then terminate.
import type { ControlPlaneTarget } from "../cp-client.ts";
import type { RotateDeps } from "./index.ts";

/** How long a drained control plane keeps its sockets before it is terminated. */
export const DRAIN_GRACE_MS = 5_000;

/** Terminate without failing the run: a MicroVM that is already gone is the outcome wanted. */
export async function terminateQuietly(
  deps: Pick<RotateDeps, "microvms" | "log">,
  microvmId: string,
  why: string,
): Promise<void> {
  try {
    await deps.microvms.terminate(microvmId);
    deps.log.info("rotate: terminated", { microvmId, why });
  } catch (error) {
    deps.log.warn("rotate: terminate failed", { microvmId, why, reason: String(error) });
  }
}

/** Drain a control plane's clients, then terminate it. Failures here never fail a rotation. */
export async function retire(
  deps: Pick<RotateDeps, "microvms" | "log" | "sleep" | "controlPlane">,
  target: ControlPlaneTarget,
  next: number,
  secret: string,
): Promise<number> {
  let drained = 0;
  const client = deps.controlPlane?.(secret);
  if (client && target.endpoint) {
    try {
      drained = (await client.drain(target, next)).drained;
      deps.log.info("rotate: drained", { microvmId: target.microvmId, clients: drained });
    } catch (error) {
      deps.log.warn("rotate: drain failed; terminating anyway", {
        microvmId: target.microvmId,
        reason: String(error),
      });
    }
  }
  await deps.sleep.sleep(DRAIN_GRACE_MS);
  await terminateQuietly(deps, target.microvmId, "rotated out");
  return drained;
}
