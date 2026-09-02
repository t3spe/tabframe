import type { IncomingMessage, ServerResponse } from "node:http";
import type { Role } from "./config.ts";
import { readBody, sendJson } from "./static.ts";

export const HOOK_PREFIX = "/aws/lambda-microvms/runtime/v1/";

/** What the fleet function puts in the run-hook payload (design §9.3). */
export interface RunPayload {
  role: Exclude<Role, "neutral">;
  generation: number;
  snapshotKey: string | null;
  sessionUrl: string | null;
  storeBase: string | null;
  fleetSecret: string | null;
}

export interface HookHost {
  /** Called on /run with the parsed payload; returns false if the payload is unusable. */
  onRun(payload: RunPayload, microvmId: string | null): Promise<boolean>;
  /** Called on /validate; runs the in-process self-test and returns true when it passes. */
  onValidate(): boolean;
  onSuspend(): Promise<void>;
  onResume(): Promise<void>;
  onTerminate(): Promise<void>;
  isListening(): boolean;
}

/**
 * The MicroVM lifecycle hooks (design §9.3). They live on the private port; the proxy never
 * routes browser tokens here. Locally they are ordinary routes a dev script can POST to.
 */
export async function handleHook(
  host: HookHost,
  name: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
  switch (name) {
    case "ready":
      return sendJson(res, host.isListening() ? 200 : 503, { ready: host.isListening() });
    case "validate":
      return sendJson(res, host.onValidate() ? 200 : 503, { validated: true });
    case "run": {
      const body = await readBody(req, 64 * 1024);
      const parsed = parseRunBody(body);
      if (!parsed) return sendJson(res, 400, { error: "bad run payload" });
      const ok = await host.onRun(parsed.payload, parsed.microvmId);
      return sendJson(res, ok ? 200 : 400, { role: parsed.payload.role, ok });
    }
    case "resume":
      await host.onResume();
      return sendJson(res, 200, { resumed: true });
    case "suspend":
      await host.onSuspend();
      return sendJson(res, 200, { suspended: true });
    case "terminate":
      await host.onTerminate();
      return sendJson(res, 200, { terminated: true });
    default:
      return sendJson(res, 404, { error: `unknown hook ${name}` });
  }
}

export function parseRunBody(
  body: Uint8Array | null,
): { payload: RunPayload; microvmId: string | null } | null {
  if (!body) return null;
  let outer: unknown;
  try {
    outer = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  if (!outer || typeof outer !== "object") return null;
  const o = outer as { microvmId?: unknown; runHookPayload?: unknown };
  let inner: unknown = o.runHookPayload;
  if (typeof inner === "string") {
    try {
      inner = JSON.parse(inner);
    } catch {
      return null;
    }
  }
  if (!inner || typeof inner !== "object") return null;
  const p = inner as Record<string, unknown>;
  if (p.role !== "control-plane" && p.role !== "core") return null;
  const generation =
    typeof p.generation === "number" && Number.isInteger(p.generation) && p.generation >= 0
      ? p.generation
      : null;
  if (generation === null) return null;
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    microvmId: str(o.microvmId),
    payload: {
      role: p.role,
      generation,
      snapshotKey: str(p.snapshotKey),
      sessionUrl: str(p.sessionUrl),
      storeBase: str(p.storeBase),
      fleetSecret: str(p.fleetSecret),
    },
  };
}
