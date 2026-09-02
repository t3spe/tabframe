// Talking to a control plane's private port through the MicroVM proxy (design §9.3, §9.4). Every
// call mints a short-lived token scoped to that MicroVM and port 8081, and carries the fleet
// secret from the run payload; browser tokens are scoped to 8080 and cannot reach any of this.
import type { MicrovmClient } from "./types.ts";

export const PRIVATE_PORT = 8081;
/** Tokens for a fleet call live as briefly as the API allows. */
export const FLEET_TOKEN_MINUTES = 1;

export interface ControlPlaneTarget {
  microvmId: string;
  endpoint: string;
}

export interface HandoverResult {
  generation: number;
  /** The serialized ledger, verbatim, so it is posted to `/adopt` byte for byte. */
  ledger: string;
}

export interface ControlPlaneClient {
  /** Step 2: stop the old control plane and take its ledger. */
  handover(target: ControlPlaneTarget): Promise<HandoverResult>;
  /** Step 3: hand the ledger to the successor. */
  adopt(target: ControlPlaneTarget, ledger: string): Promise<{ generation: number }>;
  /** Step 5: let the old control plane's clients go, with a jittered reconnect delay. */
  drain(target: ControlPlaneTarget, next: number): Promise<{ drained: number }>;
  health(target: ControlPlaneTarget): Promise<{ role: string; generation: number }>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class HttpControlPlaneClient implements ControlPlaneClient {
  private readonly microvms: MicrovmClient;
  private readonly secret: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: {
    microvms: MicrovmClient;
    secret: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  }) {
    this.microvms = opts.microvms;
    this.secret = opts.secret;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  private async call(target: ControlPlaneTarget, path: string, body?: unknown): Promise<string> {
    const token = await this.microvms.createAuthToken(target.microvmId, FLEET_TOKEN_MINUTES, [
      { port: PRIVATE_PORT },
    ]);
    const headers: Record<string, string> = {
      "X-aws-proxy-auth": token,
      "X-aws-proxy-port": String(PRIVATE_PORT),
      "x-tabframe-fleet-secret": this.secret,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`https://${target.endpoint}${path}`, {
        method: "POST",
        headers,
        ...(body === undefined
          ? {}
          : { body: typeof body === "string" ? body : JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${path} on ${target.microvmId} answered ${res.status}`);
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  async handover(target: ControlPlaneTarget): Promise<HandoverResult> {
    const text = await this.call(target, "/handover");
    const parsed = JSON.parse(text) as { generation?: unknown; ledger?: unknown };
    if (typeof parsed.generation !== "number" || typeof parsed.ledger !== "object") {
      throw new Error(`/handover on ${target.microvmId} returned an unusable body`);
    }
    // Re-serialize the ledger sub-object: /adopt wants the ledger alone.
    return { generation: parsed.generation, ledger: JSON.stringify(parsed.ledger) };
  }

  async adopt(target: ControlPlaneTarget, ledger: string): Promise<{ generation: number }> {
    const text = await this.call(target, "/adopt", ledger);
    const parsed = JSON.parse(text) as { generation?: unknown };
    return { generation: typeof parsed.generation === "number" ? parsed.generation : 0 };
  }

  async drain(target: ControlPlaneTarget, next: number): Promise<{ drained: number }> {
    const text = await this.call(target, "/drain", { next });
    const parsed = JSON.parse(text) as { drained?: unknown };
    return { drained: typeof parsed.drained === "number" ? parsed.drained : 0 };
  }

  async health(target: ControlPlaneTarget): Promise<{ role: string; generation: number }> {
    const text = await this.call(target, "/health");
    const parsed = JSON.parse(text) as { role?: unknown; generation?: unknown };
    return {
      role: typeof parsed.role === "string" ? parsed.role : "unknown",
      generation: typeof parsed.generation === "number" ? parsed.generation : 0,
    };
  }
}
