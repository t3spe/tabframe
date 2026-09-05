// The one identity the operator tooling runs under: the dedicated Tabframe profile in its region.
import { REGION_DEFAULT } from "./names.ts";

export const OPERATOR_PROFILE = "tabframe";

/** Why `env` is not the Tabframe operator identity, or null when it is. */
export function identityProblem(env: Record<string, string | undefined>): string | null {
  const profile = env.AWS_PROFILE;
  if (profile !== OPERATOR_PROFILE) {
    return `AWS_PROFILE is ${profile ?? "unset"}, expected "${OPERATOR_PROFILE}"`;
  }
  const region = env.AWS_REGION ?? "";
  if (region !== REGION_DEFAULT)
    return `AWS_REGION is ${region || "unset"}, expected ${REGION_DEFAULT}`;
  return null;
}

/** Throws unless `env` is the Tabframe operator identity, so nothing falls back to another profile. */
export function assertTabframeIdentity(env: Record<string, string | undefined>): void {
  const problem = identityProblem(env);
  if (problem) throw new Error(`refusing to touch AWS: ${problem}`);
}
