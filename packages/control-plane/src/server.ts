import { promises as dns } from "node:dns";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import {
  adoptLedger,
  apply,
  beginHandover,
  type Clock,
  createLedger,
  DEFAULT_TASK_LIMITS,
  deserializeLedger,
  drain,
  type Effect,
  type Event,
  type Ledger,
  systemClock,
} from "@tabframe/core";
import { encode, LIMITS, PROTOCOL_VERSION } from "@tabframe/protocol";
import {
  HASH_RE,
  LocalStore,
  MemorySnapshots,
  parseRange,
  S3Snapshots,
  S3Store,
  type SnapshotStore,
  type StoreDriver,
} from "@tabframe/store";
import { type WebSocket, WebSocketServer } from "ws";
import { resolveBundle } from "./bundles.ts";
import type { Config, Role } from "./config.ts";
import { type CoreFleet, createCoreFleet } from "./cores.ts";
import { HOOK_PREFIX, type HookHost, handleHook, type RunPayload } from "./hooks.ts";
import { log } from "./log.ts";
import { type DiscoveredProgram, discoverPrograms, seedPrograms } from "./seed.ts";
import { type SnapshotStatus, Snapshotter } from "./snapshotter.ts";
import { readBody, send, sendJson, serveStatic } from "./static.ts";

const MAX_BLOB_BYTES = 8 * 1024 * 1024;
/** A serialized ledger: tasks carry base64 inputs, so it is bigger than the blob cap. */
const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
/** Private routes that require the fleet secret from the run payload (design §8). */
const FLEET_ROUTES = new Set(["/handover", "/adopt", "/drain", "/snapshot", "/diag"]);

function parseNext(body: Uint8Array | null): number | null {
  if (!body || body.length === 0) return null;
  try {
    const v = (JSON.parse(new TextDecoder().decode(body)) as { next?: unknown }).next;
    return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
  } catch {
    return null;
  }
}

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
  readonly store: StoreDriver;
  readonly snapshots: SnapshotStatus;
  /** The rotation phase of this control plane (design §9.4). */
  readonly phase: "neutral" | "active" | "handing-over" | "drained";
  /** Resolves when seeding has run for the current ledger (tests wait on it). */
  seeded(): Promise<void>;
  /** Write a snapshot now if the ledger changed; the key written, or null. */
  snapshot(force?: boolean): Promise<string | null>;
  close(): Promise<void>;
}

/** Seams the tests use: an injected store, snapshot store, or program list. */
export interface ControlPlaneDeps {
  store?: StoreDriver;
  snapshots?: SnapshotStore;
  programs?: DiscoveredProgram[];
  /** Injected in tests; in the image it is built from the run payload. */
  cores?: CoreFleet;
}

/**
 * The control-plane process (design §9.3): boots neutral, becomes a control plane at boot in
 * local mode or on the /run hook in the image, and from then on turns socket activity and timer
 * ticks into core events and core effects into socket sends and closes.
 */
export async function createControlPlane(
  config: Config,
  clock: Clock = systemClock,
  deps: ControlPlaneDeps = {},
): Promise<ControlPlane> {
  let role: Role = "neutral";
  let generation = config.generation;
  let ledger: Ledger | null = null;
  let fleetSecret: string | null = null;
  let cores: CoreFleet | null = deps.cores ?? null;
  let sessionUrl: string | null = config.sessionUrl;
  let seeding: Promise<void> = Promise.resolve();
  const startedAt = clock.now();

  const rng = () => Math.random();
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
  const local = new LocalStore(storeBase);
  // Image mode writes to the blob bucket behind CloudFront; local mode serves blobs itself.
  const store: StoreDriver =
    deps.store ??
    (config.mode === "image" && config.blobBucket
      ? new S3Store({ bucket: config.blobBucket, base: storeBase })
      : local);
  const snapshots: SnapshotStore =
    deps.snapshots ??
    (config.mode === "image" && config.snapshotBucket
      ? new S3Snapshots({ bucket: config.snapshotBucket })
      : new MemorySnapshots());
  const snapshotter = new Snapshotter(snapshots);

  /** Fresh or adopted, the ledger is ours from here: announce the role and seed the programs. */
  /** Cloud cores need the image, the core role, and a session URL to point the cores at. */
  function canRunCores(): boolean {
    return Boolean(
      deps.cores ??
        (config.imageArn && config.coreRoleArn && sessionUrl && config.mode === "image"),
    );
  }

  function becomeControlPlane(gen: number, base: string, adopted: Ledger | null): void {
    generation = gen;
    if (adopted) {
      execute(adoptLedger(adopted, gen, clock.now()));
      adopted.meta.storeBase = base;
      ledger = adopted;
    } else {
      ledger = createLedger(gen, { storeBase: base, cloudCores: canRunCores() });
    }
    ledger.config.cloudCores = canRunCores();
    if (canRunCores() && !cores) {
      cores = createCoreFleet({
        imageArn: config.imageArn as string,
        imageVersion: config.imageVersion,
        coreRoleArn: config.coreRoleArn as string,
        region: config.region,
        sessionUrl: sessionUrl as string,
        storeBase: base,
        generation: gen,
        fleetSecret,
      });
    }
    role = "control-plane";
    log("role", { role, generation, adopted: adopted !== null });
    const mine = ledger;
    seeding = seed(mine).catch((err) => log("seed-failed", { error: String(err) }));
  }

  /**
   * Seeding (design §5.6): the demo programs go into the store as bundles on the first adopt of
   * a ledger without programs; the configured default program becomes the machine's loop.
   */
  async function seed(target: Ledger): Promise<void> {
    if (target.programs.size > 0) return;
    const programs =
      deps.programs ?? (config.programsDir ? discoverPrograms(config.programsDir) : []);
    if (programs.length === 0) {
      log("seed", { programs: [], note: "no programs found", dir: config.programsDir });
      return;
    }
    const { seeded, rejected } = await seedPrograms(store, programs);
    for (const r of rejected) log("seed-rejected", r);
    if (ledger !== target) return; // the role changed under us
    const loop = seeded.find((p) => p.name === config.defaultProgram) ?? seeded[0] ?? null;
    if (loop && !target.config.defaultLoop) {
      target.config.defaultLoop = { bundle: loop.bundle, params: loop.manifest.defaultParams };
    }
    for (const p of seeded) {
      dispatch({
        kind: "programAdded",
        bundle: p.bundle,
        module: p.module,
        manifest: p.manifest,
        files: p.files,
      });
    }
    log("seed", {
      programs: seeded.map((p) => ({ name: p.name, bundle: p.bundle.slice(0, 12) })),
      defaultLoop: loop?.name ?? null,
    });
  }

  if (config.mode === "local" && !config.localNeutral) {
    becomeControlPlane(config.generation, storeBase, null);
  }

  const timer = setInterval(() => {
    if (ledger) dispatch({ kind: "tick" });
  }, config.tickMs);
  const snapshotTimer = setInterval(() => {
    if (ledger && role === "control-plane") {
      void snapshotter
        .write(ledger, clock.now())
        .catch((err) => log("snapshot-failed", { error: String(err) }));
    }
  }, config.snapshotEveryMs);

  function dispatch(event: Event): void {
    if (!ledger) return;
    execute(apply(ledger, event, clock.now()));
  }

  function execute(effects: Effect[]): void {
    for (const e of effects) {
      switch (e.kind) {
        case "send": {
          const ws = conns.get(e.connId);
          if (ws && ws.readyState === ws.OPEN) ws.send(encode(e.msg));
          break;
        }
        case "close": {
          const ws = conns.get(e.connId);
          if (ws) ws.close(e.code, e.reason.slice(0, 120));
          break;
        }
        case "presign":
          void store
            .presign(e.items)
            .then((urls) => {
              const ws = conns.get(e.connId);
              if (ws && ws.readyState === ws.OPEN) {
                ws.send(encode({ t: "presigned", v: PROTOCOL_VERSION, gen: generation, urls }));
              }
            })
            .catch((err) => log("presign-failed", { error: String(err) }));
          break;
        case "fetchBlob":
          void store
            .get(e.hash)
            .then((bytes) =>
              dispatch({ kind: "blobFetched", hash: e.hash, bytes, purpose: e.purpose }),
            )
            .catch((err) => {
              log("fetch-failed", { hash: e.hash, error: String(err) });
              dispatch({ kind: "blobFetched", hash: e.hash, bytes: null, purpose: e.purpose });
            });
          break;
        case "launchCore": {
          if (!cores) break;
          void cores
            .launch()
            .then((microvmId) => {
              log("core-launched", { microvmId });
              dispatch({ kind: "coreLaunched", microvmId });
            })
            .catch((err) => log("core-launch-failed", { error: String(err) }));
          break;
        }
        case "terminateCore": {
          const { microvmId } = e;
          if (!cores) break;
          void cores
            .terminate(microvmId)
            .then(() => log("core-terminated", { microvmId }))
            .catch((err) => log("core-terminate-failed", { microvmId, error: String(err) }));
          break;
        }
        case "resolveBundle": {
          const { bundle, connId, params, inherit } = e;
          void resolveBundle(store, bundle, DEFAULT_TASK_LIMITS.memoryPagesMax)
            .then((r) => {
              if (!r.ok) {
                log("bundle-rejected", { bundle: bundle.slice(0, 12), reason: r.reason });
                dispatch({ kind: "bundleRejected", bundle, connId, reason: r.reason });
                return;
              }
              log("bundle-accepted", { bundle: bundle.slice(0, 12), name: r.manifest.name });
              dispatch({
                kind: "programAdded",
                bundle: r.bundle,
                module: r.module,
                manifest: r.manifest,
                files: r.files,
              });
              dispatch({ kind: "launch", bundle, params, human: true, inherit, connId });
            })
            .catch((err) => {
              log("bundle-failed", { bundle: bundle.slice(0, 12), error: String(err) });
              dispatch({ kind: "bundleRejected", bundle, connId, reason: `store error` });
            });
          break;
        }
        case "putBlob":
          void store
            .put(e.bytes)
            .then((hash) =>
              dispatch({ kind: "blobStored", hash, size: e.bytes.length, purpose: e.purpose }),
            )
            .catch((err) => log("put-failed", { error: String(err) }));
          break;
      }
    }
  }

  function onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const connRole = path === "/node" ? "node" : path === "/observer" ? "observer" : null;
    // A control plane that has handed over takes no new clients; they belong to its successor.
    if (!connRole || role !== "control-plane" || ledger?.meta.phase !== "active") {
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
      const r = await local.putVerified(hash, body);
      if (!r.ok) return sendJson(res, 400, { error: "bytes do not hash to key", actual: r.actual });
      return sendJson(res, 200, { hash, size: r.size });
    }
    const bytes = local.getSync(hash);
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
    async onRun(payload: RunPayload, microvmId: string | null): Promise<boolean> {
      if (role !== "neutral") {
        log("run-refused", { reason: "role already assumed", role });
        return false;
      }
      fleetSecret = payload.fleetSecret;
      sessionUrl = payload.sessionUrl ?? sessionUrl;
      log("run", {
        microvmId,
        role: payload.role,
        generation: payload.generation,
        snapshotKey: payload.snapshotKey,
        hasSecret: fleetSecret !== null,
      });
      if (payload.role === "control-plane") {
        // Adopt from a snapshot when the fleet names one (design §9.4); a missing or unreadable
        // snapshot means a fresh ledger, which idempotency makes safe.
        let adopted: Ledger | null = null;
        if (payload.snapshotKey) {
          try {
            adopted = await snapshotter.read(payload.snapshotKey);
            log(adopted ? "snapshot-adopted" : "snapshot-missing", { key: payload.snapshotKey });
          } catch (err) {
            log("snapshot-unreadable", { key: payload.snapshotKey, error: String(err) });
          }
        }
        if (role !== "neutral") return false; // a second /run raced us while we read
        becomeControlPlane(payload.generation, payload.storeBase ?? storeBase, adopted);
        return true;
      }
      role = "core";
      generation = payload.generation;
      if (!payload.sessionUrl) {
        log("run-refused", { reason: "a core needs a session URL" });
        return false;
      }
      // The node orchestrator is the same code a browser tab runs (design §4, §9.3). It is
      // started here rather than as a separate process so the image stays one entry point.
      const { startCore } = await import("./core-node.ts");
      startCore({ sessionUrl: payload.sessionUrl, microvmId, log });
      log("role", { role, generation, hostId: `core-${microvmId ?? "unknown"}` });
      return true;
    },
    async onSuspend() {
      log("suspend", { nodes: ledger?.nodes.size ?? 0 });
      await snapshotNow("suspend");
    },
    async onResume() {
      log("resume", {});
    },
    async onTerminate() {
      log("terminate", {});
      await snapshotNow("terminate");
    },
  };

  /** The lifecycle hooks write a snapshot whatever the change state; failures are logged. */
  async function snapshotNow(reason: string): Promise<string | null> {
    if (!ledger || role !== "control-plane") return null;
    try {
      const key = await snapshotter.write(ledger, clock.now(), true);
      log("snapshot", { reason, key });
      return key;
    } catch (err) {
      log("snapshot-failed", { reason, error: String(err) });
      return null;
    }
  }

  /**
   * The fleet's routes carry the secret from the run payload (design §8, §9.3). In local mode
   * there is no payload and no secret, so they are open — the private port is not routable from a
   * browser in either case, and locally it is bound to the loopback address.
   */
  function fleetAuthorized(req: IncomingMessage): boolean {
    if (!fleetSecret) return true;
    const header = req.headers["x-tabframe-fleet-secret"];
    const given = Array.isArray(header) ? header[0] : header;
    if (typeof given !== "string" || given.length !== fleetSecret.length) return false;
    // Constant-time enough for a secret compared a handful of times an hour.
    let diff = 0;
    for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ fleetSecret.charCodeAt(i);
    return diff === 0;
  }

  async function handlePrivate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith(HOOK_PREFIX))
      return handleHook(hookHost, url.pathname.slice(HOOK_PREFIX.length), req, res);
    if (FLEET_ROUTES.has(url.pathname) && !fleetAuthorized(req)) {
      log("fleet-unauthorized", { path: url.pathname });
      return sendJson(res, 403, { error: "fleet secret required" });
    }
    if (url.pathname === "/handover" && req.method === "POST") {
      // Step 2 of a rotation: stop assigning, pause intake, hand the ledger over (design §9.4).
      if (!ledger || role !== "control-plane") return sendJson(res, 409, { error: "no ledger" });
      const { json, generation: gen } = beginHandover(ledger);
      await snapshotNow("handover");
      log("handover", { generation: gen, nodes: ledger.nodes.size, bytes: json.length });
      return send(res, 200, "application/json", `{"generation":${gen},"ledger":${json}}`);
    }
    if (url.pathname === "/adopt" && req.method === "POST") {
      // Step 3: become the active control plane with the ledger the previous one handed over.
      const body = await readBody(req, MAX_LEDGER_BYTES);
      if (!body) return sendJson(res, 413, { error: "ledger too large" });
      let adopted: Ledger;
      try {
        adopted = deserializeLedger(new TextDecoder().decode(body));
      } catch (err) {
        log("adopt-failed", { error: String(err) });
        return sendJson(res, 400, { error: "unreadable ledger" });
      }
      // A ledger from a *later* generation would be a rollback; anything at or before ours is
      // either the handover we were launched for or a retry of it, and adopting twice is safe.
      if (adopted.meta.generation > generation) {
        log("adopt-refused", { theirs: adopted.meta.generation, ours: generation });
        return sendJson(res, 409, { error: "that ledger is newer than this control plane" });
      }
      const gen = generation;
      becomeControlPlane(gen, adopted.meta.storeBase || storeBase, adopted);
      await seeding;
      dispatch({ kind: "tick" });
      log("adopt", { generation: gen, nodes: adopted.nodes.size });
      return sendJson(res, 200, { adopted: true, generation: gen });
    }
    if (url.pathname === "/drain" && req.method === "POST") {
      // Step 5: let every client go with a jittered reconnect delay (design §8.4, §9.4).
      if (!ledger || role !== "control-plane") return sendJson(res, 409, { error: "no ledger" });
      const body = await readBody(req, 4096);
      const next = parseNext(body) ?? generation + 1;
      const clients = ledger.conns.size;
      execute(drain(ledger, next, rng));
      for (const ws of conns.values()) ws.close(1001, "rotating");
      conns.clear();
      await snapshotNow("drain");
      log("drain", { next, clients });
      return sendJson(res, 200, { drained: clients, next });
    }
    if (url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        role,
        mode: config.mode,
        generation,
        protocol: PROTOCOL_VERSION,
        nodes: ledger?.nodes.size ?? 0,
        observers: ledger?.observers.size ?? 0,
        programs: ledger?.programs.size ?? 0,
        running: ledger?.running ?? null,
        queue: ledger?.queue.length ?? 0,
        snapshots: snapshotter.status,
        uptimeMs: clock.now() - startedAt,
      });
    }
    if (url.pathname === "/snapshot" && req.method === "GET") {
      // The ledger as it stands (design §9.4); the handover path of M3 reads the same shape.
      if (!ledger) return sendJson(res, 503, { error: "no ledger" });
      return send(res, 200, "application/json", snapshotter.current(ledger));
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
        storeBase: ledger?.meta.storeBase ?? storeBase,
        blobs: local.size,
        role,
        generation,
        node: process.version,
      });
    }
    sendJson(res, 404, { error: "not found" });
  }

  return {
    get phase() {
      return role === "control-plane" ? (ledger?.meta.phase ?? "active") : "neutral";
    },
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
    get snapshots() {
      return snapshotter.status;
    },
    seeded: () => seeding,
    snapshot: (force = false) =>
      ledger && role === "control-plane"
        ? snapshotter.write(ledger, clock.now(), force)
        : Promise.resolve(null),
    async close() {
      clearInterval(timer);
      clearInterval(snapshotTimer);
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
