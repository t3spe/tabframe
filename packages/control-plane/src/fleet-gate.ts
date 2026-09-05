import type { IncomingMessage } from "node:http";
import type { Role } from "./config.ts";

export interface FleetGateDeps {
  role: () => Role;
  secret: () => string | null;
  /** Without a secret the routes are open only where no fleet exists: a laptop, or a test that says so. */
  open: boolean;
}

/**
 * The fleet's routes carry the secret from the run payload (design §8, §9.3). In local mode there
 * is no payload and no secret, so they are open; the private port is not routable from a browser
 * in either case, and locally it is bound to the loopback address.
 */
export function createFleetGate(deps: FleetGateDeps): (req: IncomingMessage) => boolean {
  return (req) => {
    // A core gates no fleet route and never becomes a control plane.
    if (deps.role() === "core") return false;
    const secret = deps.secret();
    // An image that has not received its run payload yet refuses instead of failing open.
    if (!secret) return deps.open;
    const header = req.headers["x-tabframe-fleet-secret"];
    const given = Array.isArray(header) ? header[0] : header;
    return typeof given === "string" && constantTimeEqual(given, secret);
  };
}

/** Constant-time enough for a secret compared a handful of times an hour. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
