import { promises as dns } from "node:dns";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import {
  apply,
  type Clock,
  createLedger,
  type Effect,
  type Event,
  type Ledger,
  systemClock,
} from "@tabframe/core";
import { encode, LIMITS, PROTOCOL_VERSION } from "@tabframe/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import type { Config, Role } from "./config.ts";
import { HOOK_PREFIX, type HookHost, handleHook, type RunPayload } from "./hooks.ts";
import { log } from "./log.ts";
import { readBody, send, sendJson, serveStatic } from "./static.ts";
import { HASH_RE, LocalStore, parseRange } from "./store/local.ts";

const MAX_BLOB_BYTES = 8 * 1024 * 1024;

export interface Address {
  host: string;
  port: number;
}

export interface ControlPlane {
  readonly publicAddress: Address;
  readonly privateAddress: Address;
  readonly role: Role;
  readonly generation: number;
  /** Present once the process is a control plane. */
  readonly ledger: Ledger | null;
  readonly store: LocalStore;
  close(): Promise<void>;
}

/**
 * The control-plane process (design §9.3): boots neutral, becomes a control plane at boot in
 * local mode or on the /run hook in the image, and from then on turns socket activity and timer
 * ticks into core events and core effects into socket sends and closes.
 */
export async function createControlPlane(
  config: Config,
  clock: Clock = systemClock,
): Promise<ControlPlane> {
  let role: Role = "neutral";
  let generation = config.generation;
  let ledger: Ledger | null = null;
  let fleetSecret: string | null = null;
  const startedAt = clock.now();

  const conns = new Map<string, WebSocket>();
  let connCounter = 0;
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxMessageBytes });

  const publicServer = createServer(
    (req, res) => void handlePublic(req, res).catch((err) => fail(res, err)),
  );
  const privateServer = createServer(
    (req, res) => void handlePrivate(req, res).catch((err) => fail(res, err)),
  );
  publicServer.on("upgrade", onUpgrade);

  const publicAddress = await listen(publicServer, config.publicPort, config.host);
  const privateAddress = await listen(privateServer, config.privatePort, config.host);
  const storeBase = config.storeBase ?? `http://${publicAddress.host}:${publicAddress.port}/blob`;
  const store = new LocalStore(storeBase);

  function becomeControlPlane(gen: number, base: string): void {
    generation = gen;
    ledger = createLedger(gen, { storeBase: base });
    role = "control-plane";
    log("role", { role, generation });
  }

  if (config.mode === "local") becomeControlPlane(config.generation, storeBase);

  const timer = setInterval(() => {
    if (ledger) dispatch({ kind: "tick" });
  }, config.tickMs);

  function dispatch(event: Event): void {
    if (!ledger) return;
    execute(apply(ledger, event, clock.now()));
  }

  function execute(effects: Effect[]): void {
    for (const e of effects) {
      const ws = conns.get(e.connId);
      if (!ws) continue;
      if (e.kind === "send") {
        if (ws.readyState === ws.OPEN) ws.send(encode(e.msg));
      } else {
        ws.close(e.code, e.reason.slice(0, 120));
      }
    }
  }

  function onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const connRole = path === "/node" ? "node" : path === "/observer" ? "observer" : null;
    if (!connRole || role !== "control-plane") {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const connId = `c${++connCounter}`;
      conns.set(connId, ws);
      dispatch({ kind: "connected", connId, role: connRole });
      ws.on("message", (data, isBinary) => {
        dispatch({ kind: "message", connId, raw: isBinary ? data : data.toString() });
      });
      ws.on("close", () => {
        conns.delete(connId);
        dispatch({ kind: "disconnected", connId });
      });
      ws.on("error", (err) => log("socket-error", { connId, error: String(err) }));
    });
  }

  async function handlePublic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    if (config.mode === "local" && url.pathname === "/session" && req.method === "GET") {
      if (config.localOff) return sendJson(res, 200, { off: true });
      return sendJson(res, 200, {
        endpoint: `ws://${publicAddress.host}:${publicAddress.port}`,
        token: "local",
        expiresAt: clock.now() + 30 * 60_000,
        storeBase,
        generation,
      });
    }
    if (config.mode === "local" && url.pathname === "/config.json") {
      return sendJson(res, 200, { sessionUrl: "/session" });
    }
    if (config.mode === "local" && url.pathname.startsWith("/blob/"))
      return handleBlob(url.pathname.slice(6), req, res);
    return serveStatic(config.webDir, req, res);
  }

  async function handleBlob(
    hash: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!HASH_RE.test(hash)) return send(res, 400, "text/plain", "not a sha-256 hex key");
    if (req.method === "PUT") {
      const body = await readBody(req, MAX_BLOB_BYTES);
      if (!body) return send(res, 413, "text/plain", "blob too large");
      const r = store.putVerified(hash, body);
      if (!r.ok) return sendJson(res, 400, { error: "bytes do not hash to key", actual: r.actual });
      return sendJson(res, 200, { hash, size: r.size });
    }
    const bytes = store.get(hash);
    if (!bytes) return send(res, 404, "text/plain", "unknown blob");
    const headers: Record<string, string | number> = {
      "content-type": "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
      "accept-ranges": "bytes",
      "access-control-allow-origin": "*",
    };
    if (req.method === "HEAD") {
      res.writeHead(200, { ...headers, "content-length": bytes.length });
      res.end();
      return;
    }
    const range = parseRange(req.headers.range, bytes.length);
    if (range === null) {
      res.writeHead(416, { "content-range": `bytes */${bytes.length}` });
      res.end();
      return;
    }
    if (range) {
      const slice = bytes.subarray(range.start, range.end + 1);
      res.writeHead(206, {
        ...headers,
        "content-length": slice.length,
        "content-range": `bytes ${range.start}-${range.end}/${bytes.length}`,
      });
      res.end(slice);
      return;
    }
    res.writeHead(200, { ...headers, "content-length": bytes.length });
    res.end(bytes);
  }

  const hookHost: HookHost = {
    isListening: () => publicServer.listening && privateServer.listening,
    onValidate: () => selfTest(),
    onRun(payload: RunPayload, microvmId: string | null): boolean {
      if (role !== "neutral") {
        log("run-refused", { reason: "role already assumed", role });
        return false;
      }
      fleetSecret = payload.fleetSecret;
      log("run", {
        microvmId,
        role: payload.role,
        generation: payload.generation,
        hasSecret: fleetSecret !== null,
      });
      if (payload.role === "control-plane") {
        becomeControlPlane(payload.generation, payload.storeBase ?? storeBase);
        return true;
      }
      role = "core";
      generation = payload.generation;
      log("role", { role, note: "core orchestrator arrives in WP3.3" });
      return true;
    },
    async onSuspend() {
      log("suspend", { nodes: ledger?.nodes.size ?? 0 });
    },
    async onResume() {
      log("resume", {});
    },
    async onTerminate() {
      log("terminate", {});
    },
  };

  async function handlePrivate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith(HOOK_PREFIX))
      return handleHook(hookHost, url.pathname.slice(HOOK_PREFIX.length), req, res);
    if (url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        role,
        mode: config.mode,
        generation,
        protocol: PROTOCOL_VERSION,
        nodes: ledger?.nodes.size ?? 0,
        observers: ledger?.observers.size ?? 0,
        uptimeMs: clock.now() - startedAt,
      });
    }
    if (url.pathname === "/diag") {
      const t0 = Date.now();
      let dnsResult: string;
      try {
        const addrs = await dns.resolve4("s3.us-west-2.amazonaws.com");
        dnsResult = `ok (${addrs.length} addresses, ${Date.now() - t0} ms)`;
      } catch (err) {
        dnsResult = `failed: ${String(err)}`;
      }
      return sendJson(res, 200, {
        dns: dnsResult,
        storeBase,
        blobs: store.size,
        role,
        generation,
        node: process.version,
      });
    }
    sendJson(res, 404, { error: "not found" });
  }

  return {
    get publicAddress() {
      return publicAddress;
    },
    get privateAddress() {
      return privateAddress;
    },
    get role() {
      return role;
    },
    get generation() {
      return generation;
    },
    get ledger() {
      return ledger;
    },
    store,
    async close() {
      clearInterval(timer);
      for (const ws of conns.values()) ws.terminate();
      conns.clear();
      wss.close();
      await Promise.all([closeServer(publicServer), closeServer(privateServer)]);
    },
  };
}

/** The /validate self-test: a hello, a heartbeat, and a tick against a scratch ledger. */
export function selfTest(): boolean {
  const scratch = createLedger(0, { storeBase: "http://self-test/blob" });
  const now = 1_000;
  apply(scratch, { kind: "connected", connId: "t", role: "node" }, now);
  const hello = JSON.stringify({
    t: "hello",
    v: PROTOCOL_VERSION,
    gen: 0,
    hostId: "self",
    kind: "core",
    cores: 1,
    sandboxVersion: "1",
  });
  const effects = apply(scratch, { kind: "message", connId: "t", raw: hello }, now);
  const welcomed = effects.some((e) => e.kind === "send" && e.msg.t === "welcome");
  const heartbeat = JSON.stringify({
    t: "heartbeat",
    v: PROTOCOL_VERSION,
    gen: 0,
    visible: true,
    queue: 0,
    lastTaskMs: null,
    tasksDone: 0,
  });
  apply(scratch, { kind: "message", connId: "t", raw: heartbeat }, now + 1_000);
  apply(scratch, { kind: "tick" }, now + 2_000);
  return welcomed && scratch.nodes.size === 1;
}

function listen(server: Server, port: number, host: string): Promise<Address> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("no address"));
      resolve({ host, port: addr.port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function fail(res: ServerResponse, err: unknown): void {
  log("request-error", { error: String(err) });
  if (!res.headersSent) sendJson(res, 500, { error: "internal" });
  else res.end();
}
