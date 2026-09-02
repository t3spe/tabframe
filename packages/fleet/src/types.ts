// Interfaces the fleet logic depends on. Everything that talks to AWS sits behind one of these so
// the handlers are tested with fakes and the real adapters (aws.ts, microvm-client.ts) stay thin.

export type MicrovmState =
  | "PENDING"
  | "RUNNING"
  | "SUSPENDED"
  | "SUSPENDING"
  | "TERMINATED"
  | "TERMINATING";

/** States in which a control plane can serve traffic (auto-resume wakes a suspended one). */
export const SERVING_STATES: ReadonlySet<MicrovmState> = new Set([
  "RUNNING",
  "SUSPENDED",
  "SUSPENDING",
]);

export interface MicrovmInfo {
  microvmId: string;
  state: MicrovmState;
  /** Hostname of the dedicated endpoint, without scheme. Null when the API did not return one. */
  endpoint: string | null;
  imageArn: string | null;
  imageVersion: string | null;
  startedAt: Date | null;
  stateReason: string | null;
}

export type PortSpec =
  | { port: number }
  | { range: { startPort: number; endPort: number } }
  | { allPorts: true };

export interface IdlePolicy {
  maxIdleDurationSeconds: number;
  suspendedDurationSeconds: number;
  autoResumeEnabled: boolean;
}

export interface RunMicrovmParams {
  imageArn: string;
  imageVersion: string | null;
  executionRoleArn: string;
  runHookPayload: string;
  ingressConnectors: string[];
  egressConnectors: string[];
  idlePolicy: IdlePolicy | null;
  maximumDurationInSeconds: number;
  clientToken: string | null;
}

export interface MicrovmClient {
  run(params: RunMicrovmParams): Promise<MicrovmInfo>;
  /** Null when the MicroVM does not exist. */
  get(microvmId: string): Promise<MicrovmInfo | null>;
  list(imageArn?: string): Promise<MicrovmInfo[]>;
  terminate(microvmId: string): Promise<void>;
  suspend(microvmId: string): Promise<void>;
  resume(microvmId: string): Promise<void>;
  /** Returns the value to present as `X-aws-proxy-auth` (or the matching WebSocket subprotocol). */
  createAuthToken(
    microvmId: string,
    expirationInMinutes: number,
    ports: PortSpec[],
  ): Promise<string>;
}

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export interface Sleeper {
  sleep(ms: number): Promise<void>;
}

export interface Invoker {
  /** Fire-and-forget (Lambda InvocationType Event). */
  invokeAsync(functionName: string, payload: unknown): Promise<void>;
  /** Request/response; returns the decoded JSON payload. */
  invokeSync(functionName: string, payload: unknown): Promise<unknown>;
}

export interface RuleControl {
  enable(ruleName: string): Promise<void>;
  disable(ruleName: string): Promise<void>;
}

export interface SecretReader {
  read(secretId: string): Promise<string>;
}

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function isThrottling(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "ThrottlingException"
  );
}

export function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "ResourceNotFoundException"
  );
}

/** Strips a scheme and trailing slash so callers can build `wss://${endpoint}` and `https://${endpoint}`. */
export function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");
}

export const realClock: Clock = { now: () => Date.now() };

export const realSleeper: Sleeper = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** JSON-lines logger for CloudWatch. */
export const consoleLogger: Logger = {
  info: (message, fields) => console.log(JSON.stringify({ level: "info", message, ...fields })),
  warn: (message, fields) => console.warn(JSON.stringify({ level: "warn", message, ...fields })),
  error: (message, fields) => console.error(JSON.stringify({ level: "error", message, ...fields })),
};
