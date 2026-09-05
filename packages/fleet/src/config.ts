// Configuration from environment variables, with the constants the design fixes (§9.2).
import { CANARY_ENV, pick, ROTATE_ENV, SESSION_ENV } from "./env.ts";
import { NAMES, REGION_DEFAULT } from "./names.ts";
import type { IdlePolicy } from "./types.ts";

export function ingressConnectorArn(region: string): string {
  return `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`;
}

export function egressConnectorArn(region: string): string {
  return `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`;
}

/** Control plane idle policy: suspend after 15 idle minutes, auto-resume, terminate after 7 suspended hours. */
export const CONTROL_PLANE_IDLE_POLICY: IdlePolicy = {
  maxIdleDurationSeconds: 900,
  suspendedDurationSeconds: 25_200,
  autoResumeEnabled: true,
};

export const CONTROL_PLANE_MAX_DURATION_SECONDS = 28_800;
export const TOKEN_TTL_MINUTES = 30;
export const TOKEN_REFRESH_MINUTES = 25;

export interface SessionConfig {
  pointerParam: string;
  storeBase: string;
  webOrigin: string;
  rotateFunctionName: string;
  retryAfterMs: number;
  /** Minimum gap between heal invocations from one warm instance. */
  healCooldownMs: number;
}

export interface RotateConfig {
  pointerParam: string;
  region: string;
  imageArn: string;
  imageVersion: string | null;
  controlPlaneRoleArn: string;
  sessionUrl: string;
  storeBase: string;
  fleetSecretArn: string;
  /**
   * Where the control plane writes its snapshots; null or absent when a successor must start empty.
   * Optional only because packages/control-plane's handover test builds this config by hand.
   */
  snapshotBucket?: string | null;
  readyTimeoutMs: number;
  pollIntervalMs: number;
}

export interface CanaryConfig {
  webOrigin: string;
  sessionUrl: string;
}

export interface OpsConfig {
  pointerParam: string;
  rotateFunctionName: string;
  ruleName: string;
  imageArn: string;
}

type Env = Record<string, string | undefined>;

function required<E extends Record<string, string | undefined>>(
  env: E,
  name: keyof E & string,
): string {
  const value = env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

export function loadSessionConfig(env: Env): SessionConfig {
  const e = pick(env, SESSION_ENV);
  return {
    pointerParam: e.TABFRAME_POINTER_PARAM ?? NAMES.pointerParam,
    storeBase: required(e, "TABFRAME_STORE_BASE"),
    webOrigin: e.TABFRAME_WEB_ORIGIN ?? "*",
    rotateFunctionName: e.TABFRAME_ROTATE_FUNCTION ?? NAMES.rotateFunction,
    retryAfterMs: 5000,
    healCooldownMs: 10_000,
  };
}

export function loadRotateConfig(env: Env): RotateConfig {
  const e = pick(env, ROTATE_ENV);
  return {
    pointerParam: e.TABFRAME_POINTER_PARAM ?? NAMES.pointerParam,
    region: env.AWS_REGION ?? REGION_DEFAULT,
    imageArn: required(e, "TABFRAME_IMAGE_ARN"),
    imageVersion: env.TABFRAME_IMAGE_VERSION ?? null,
    controlPlaneRoleArn: required(e, "TABFRAME_CP_ROLE_ARN"),
    sessionUrl: required(e, "TABFRAME_SESSION_URL"),
    storeBase: required(e, "TABFRAME_STORE_BASE"),
    fleetSecretArn: required(e, "TABFRAME_FLEET_SECRET_ARN"),
    snapshotBucket: e.TABFRAME_SNAPSHOT_BUCKET ?? null,
    // Inside the function's ten minutes, with room for the fleet calls that follow.
    readyTimeoutMs: 120_000,
    pollIntervalMs: 2000,
  };
}

/** Both addresses are required: an unset one would become a relative URL that fails every check. */
export function loadCanaryConfig(env: Env): CanaryConfig {
  const e = pick(env, CANARY_ENV);
  return {
    webOrigin: required(e, "TABFRAME_WEB_ORIGIN"),
    sessionUrl: required(e, "TABFRAME_SESSION_URL"),
  };
}

export function loadOpsConfig(env: Env): OpsConfig {
  return {
    pointerParam: env.TABFRAME_POINTER_PARAM ?? NAMES.pointerParam,
    rotateFunctionName: env.TABFRAME_ROTATE_FUNCTION ?? NAMES.rotateFunction,
    ruleName: env.TABFRAME_RULE_NAME ?? NAMES.hourlyRule,
    imageArn: required(env, "TABFRAME_IMAGE_ARN"),
  };
}
