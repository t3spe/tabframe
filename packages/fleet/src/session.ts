// The session function (design §8.1, §9.2): vends `{endpoint, token, expiresAt, storeBase, generation}`
// with one shared token per control plane, serves the off state, and heals when nothing is running.
import { type SessionConfig, TOKEN_REFRESH_MINUTES, TOKEN_TTL_MINUTES } from "./config.ts";
import { PORTS } from "./names.ts";
import type { Pointer, PointerStore } from "./pointer.ts";
import {
  type Clock,
  type Invoker,
  type Logger,
  type MicrovmClient,
  type MicrovmInfo,
  SERVING_STATES,
} from "./types.ts";

export interface FunctionUrlEvent {
  requestContext?: { http?: { method?: string; path?: string } };
  /** The function URL passes the query string whole; `probe=1` is the canary's. */
  rawQueryString?: string;
  rawPath?: string;
  headers?: Record<string, string | undefined>;
}

export interface FunctionUrlResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/** How long a warm session instance trusts its last pointer and MicroVM lookup. */
export const LOOKUP_MEMO_MS = 5_000;

export type SessionBody =
  | { off: true }
  | { starting: true; retryAfterMs: number }
  | { endpoint: string; token: string; expiresAt: string; storeBase: string; generation: number };

export interface SessionDeps {
  pointer: PointerStore;
  microvms: MicrovmClient;
  invoker: Invoker;
  clock: Clock;
  log: Logger;
  config: SessionConfig;
}

interface TokenCache {
  microvmId: string;
  token: string;
  mintedAt: number;
}

export type SessionHandler = (event: FunctionUrlEvent) => Promise<FunctionUrlResponse>;

export function createSessionHandler(deps: SessionDeps): SessionHandler {
  const { pointer, microvms, invoker, clock, log, config } = deps;
  let cache: TokenCache | null = null;
  let memo: { at: number; pointer: Pointer; info: MicrovmInfo | null } | null = null;
  let lastHealAt = Number.NEGATIVE_INFINITY;

  const cors = {
    "Access-Control-Allow-Origin": config.webOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };

  function respond(
    statusCode: number,
    body: SessionBody | { error: string },
    extra: Record<string, string> = {},
  ): FunctionUrlResponse {
    return {
      statusCode,
      headers: { ...cors, "Content-Type": "application/json", ...extra },
      body: JSON.stringify(body),
    };
  }

  async function heal(reason: string): Promise<FunctionUrlResponse> {
    const now = clock.now();
    if (now - lastHealAt >= config.healCooldownMs) {
      lastHealAt = now;
      log.info("session: invoking rotate to heal", { reason });
      await invoker.invokeAsync(config.rotateFunctionName, { reason: "heal", detail: reason });
    }
    return respond(
      200,
      { starting: true, retryAfterMs: config.retryAfterMs },
      { "Retry-After": String(Math.ceil(config.retryAfterMs / 1000)) },
    );
  }

  async function tokenFor(microvmId: string): Promise<{ token: string; expiresAt: string }> {
    const now = clock.now();
    const refreshMs = TOKEN_REFRESH_MINUTES * 60_000;
    if (!cache || cache.microvmId !== microvmId || now - cache.mintedAt >= refreshMs) {
      const token = await microvms.createAuthToken(microvmId, TOKEN_TTL_MINUTES, [
        { port: PORTS.public },
      ]);
      cache = { microvmId, token, mintedAt: now };
      log.info("session: minted shared token", { microvmId });
    }
    return {
      token: cache.token,
      expiresAt: new Date(cache.mintedAt + TOKEN_TTL_MINUTES * 60_000).toISOString(),
    };
  }

  return async (event) => {
    const method = (event.requestContext?.http?.method ?? "GET").toUpperCase();
    if (method === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
    if (method !== "GET") return respond(405, { error: "method not allowed" });

    // `?probe=1` asks for the state without healing: a heal from a monitor would keep a machine
    // nobody watches booting all night.
    const probe = event.rawQueryString?.includes("probe=1") ?? false;
    const now = clock.now();
    // The pointer and the MicroVM's state are remembered per warm instance: every visitor's fetch
    // would otherwise cost an SSM read and a GetMicrovm, and one curl loop could throttle both.
    let p: Pointer;
    let info: MicrovmInfo | null;
    if (memo && now - memo.at < LOOKUP_MEMO_MS) {
      p = memo.pointer;
      info = memo.info;
    } else {
      p = await pointer.read();
      info = p.state === "on" && p.microvmId ? await microvms.get(p.microvmId) : null;
      memo = { at: now, pointer: p, info };
    }
    if (p.state === "off") return respond(200, { off: true });
    if (!p.microvmId)
      return probe
        ? respond(200, { starting: true, retryAfterMs: config.retryAfterMs })
        : heal("pointer has no control plane");

    if (!info)
      return probe
        ? respond(200, { starting: true, retryAfterMs: config.retryAfterMs })
        : heal(`control plane ${p.microvmId} not found`);
    if (info.state === "PENDING") {
      return respond(200, { starting: true, retryAfterMs: config.retryAfterMs });
    }
    if (!SERVING_STATES.has(info.state))
      return probe
        ? respond(200, { starting: true, retryAfterMs: config.retryAfterMs })
        : heal(`control plane ${p.microvmId} is ${info.state}`);

    const endpoint = info.endpoint ?? p.endpoint;
    if (!endpoint) return heal(`control plane ${p.microvmId} has no endpoint`);

    const { token, expiresAt } = await tokenFor(info.microvmId);
    return respond(200, {
      endpoint,
      token,
      expiresAt,
      storeBase: config.storeBase,
      generation: p.generation,
    });
  };
}
