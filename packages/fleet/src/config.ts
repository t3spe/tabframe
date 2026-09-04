// Configuration from environment variables, with the constants the design fixes (§9.2).
import type { IdlePolicy } from "./types.ts";

export const REGION_DEFAULT = "us-west-2";

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
export const PUBLIC_PORT = 8080;
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
  readyTimeoutMs: number;
  pollIntervalMs: number;
}

export interface OpsConfig {
  pointerParam: string;
  rotateFunctionName: string;
  ruleName: string;
  imageArn: string;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

export function loadSessionConfig(env: Env): SessionConfig {
  return {
    pointerParam: env.TABFRAME_POINTER_PARAM ?? "/tabframe/pointer",
    storeBase: required(env, "TABFRAME_STORE_BASE"),
    webOrigin: env.TABFRAME_WEB_ORIGIN ?? "*",
    rotateFunctionName: env.TABFRAME_ROTATE_FUNCTION ?? "tabframe-rotate",
    retryAfterMs: 5000,
    healCooldownMs: 10_000,
  };
}

export function loadRotateConfig(env: Env): RotateConfig {
  return {
    pointerParam: env.TABFRAME_POINTER_PARAM ?? "/tabframe/pointer",
    region: env.AWS_REGION ?? REGION_DEFAULT,
    imageArn: required(env, "TABFRAME_IMAGE_ARN"),
    imageVersion: env.TABFRAME_IMAGE_VERSION ?? null,
    controlPlaneRoleArn: required(env, "TABFRAME_CP_ROLE_ARN"),
    sessionUrl: required(env, "TABFRAME_SESSION_URL"),
    storeBase: required(env, "TABFRAME_STORE_BASE"),
    fleetSecretArn: required(env, "TABFRAME_FLEET_SECRET_ARN"),
    readyTimeoutMs: 120_000, // (WP8.2) inside the function's budget with the fleet calls that follow
    pollIntervalMs: 2000,
  };
}

export function loadOpsConfig(env: Env): OpsConfig {
  return {
    pointerParam: env.TABFRAME_POINTER_PARAM ?? "/tabframe/pointer",
    rotateFunctionName: env.TABFRAME_ROTATE_FUNCTION ?? "tabframe-rotate",
    ruleName: env.TABFRAME_RULE_NAME ?? "tabframe-rotate-hourly",
    imageArn: required(env, "TABFRAME_IMAGE_ARN"),
  };
}
