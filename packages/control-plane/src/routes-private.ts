import type { IncomingMessage, ServerResponse } from "node:http";
import { type HookHost, handleHook, hookName } from "./hooks.ts";
import { readBody, send, sendJson } from "./http.ts";
import type { Log } from "./log.ts";
import { MAX_LEDGER_BYTES, parseNext, type Rotation } from "./rotation.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

export interface PrivateRoute {
  path: string;
  /** Any method when absent. */
  method?: "GET" | "POST";
  /** Behind the fleet secret (design §8). */
  fleet: boolean;
  handle: Handler;
}

export interface PrivateRouterDeps {
  hookHost: HookHost;
  rotation: Rotation;
  health: () => unknown;
  /** Probes DNS and the store, so it takes a moment. */
  diag: () => Promise<unknown>;
  /** The ledger as it stands, serialized; null without one. */
  snapshot: () => string | null;
  gate: (req: IncomingMessage) => boolean;
  log: Log;
}

export function privateRoutes(deps: PrivateRouterDeps): PrivateRoute[] {
  return [
    {
      path: "/handover",
      method: "POST",
      fleet: true,
      async handle(_req, res) {
        const r = await deps.rotation.handover();
        if (r.kind === "no-ledger") return sendJson(res, 409, { error: "no ledger" });
        if (r.kind === "drained") return sendJson(res, 409, { error: "already drained" });
        return send(
          res,
          200,
          "application/json",
          `{"generation":${r.generation},"ledger":${r.json}}`,
        );
      },
    },
    {
      path: "/adopt",
      method: "POST",
      fleet: true,
      async handle(req, res) {
        const body = await readBody(req, MAX_LEDGER_BYTES);
        if (!body) return sendJson(res, 413, { error: "ledger too large" });
        const r = await deps.rotation.adopt(new TextDecoder().decode(body));
        switch (r.kind) {
          case "unreadable":
            return sendJson(res, 400, { error: "unreadable ledger" });
          case "newer":
            return sendJson(res, 409, { error: "that ledger is newer than this control plane" });
          case "repeated":
            return sendJson(res, 200, { adopted: true, generation: r.generation, repeated: true });
          case "adopted":
            return sendJson(res, 200, { adopted: true, generation: r.generation });
        }
      },
    },
    {
      path: "/drain",
      method: "POST",
      fleet: true,
      async handle(req, res) {
        const body = await readBody(req, 4096);
        const r = await deps.rotation.drain(parseNext(body));
        if (r.kind === "no-ledger") return sendJson(res, 409, { error: "no ledger" });
        return sendJson(res, 200, { drained: r.drained, next: r.next });
      },
    },
    {
      // Open: it carries counts and the operator scripts poll it.
      path: "/health",
      fleet: false,
      handle: (_req, res) => sendJson(res, 200, deps.health()),
    },
    {
      path: "/snapshot",
      method: "GET",
      fleet: true,
      handle(_req, res) {
        const json = deps.snapshot();
        if (json === null) return sendJson(res, 503, { error: "no ledger" });
        return send(res, 200, "application/json", json);
      },
    },
    {
      path: "/diag",
      fleet: true,
      handle: async (_req, res) => sendJson(res, 200, await deps.diag()),
    },
  ];
}

/** The private port: the lifecycle hooks under their prefix, then the route table. */
export function createPrivateRouter(deps: PrivateRouterDeps): Handler {
  const routes = privateRoutes(deps);
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const hook = hookName(url.pathname);
    if (hook !== null) return handleHook(deps.hookHost, hook, req, res);
    const matching = routes.filter((r) => r.path === url.pathname);
    // The gate belongs to the path, whatever the method: an unauthorized caller learns nothing
    // about which methods a fleet route takes.
    if (matching.some((r) => r.fleet) && !deps.gate(req)) {
      deps.log("fleet-unauthorized", { path: url.pathname });
      return sendJson(res, 403, { error: "fleet secret required" });
    }
    const route = matching.find((r) => !r.method || r.method === req.method);
    if (!route) return sendJson(res, 404, { error: "not found" });
    await route.handle(req, res);
  };
}
