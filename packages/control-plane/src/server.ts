import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type Clock, type Ledger, systemClock } from "@tabframe/core";
import {
  LocalStore,
  MemorySnapshots,
  S3Snapshots,
  S3Store,
  type SnapshotStore,
  type StoreDriver,
} from "@tabframe/store";
import { createAuthority, type PointerReader } from "./authority.ts";
import type { Config, Role } from "./config.ts";
import type { CoreFleet, CoreFleetConfig } from "./cores.ts";
import { createEffectExecutor } from "./effects.ts";
import { createFleetGate } from "./fleet-gate.ts";
import { type BuildStamp, diagReport, healthReport, probeDiag } from "./health.ts";
import { type Address, closeServer, fail, listen, sendJson } from "./http.ts";
import { Inflight } from "./inflight.ts";
import { createLifecycle } from "./lifecycle.ts";
import { log } from "./log.ts";
import { startLoops } from "./loops.ts";
import { createBundleResolver } from "./resolutions.ts";
import { createRotation } from "./rotation.ts";
import { createPrivateRouter } from "./routes-private.ts";
import { createPublicRouter } from "./routes-public.ts";
import { createHookHost } from "./run-hook.ts";
import type { DiscoveredProgram } from "./seed.ts";
import { selfTest } from "./self-test.ts";
import { createSnapshotWriter } from "./snapshot-policy.ts";
import { type SnapshotStatus, Snapshotter } from "./snapshotter.ts";
import { createSocketGateway } from "./sockets.ts";
import { createProcessState, type Phase } from "./state.ts";

export type { Address } from "./http.ts";

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
  readonly phase: Phase;
  /** Resolves when seeding has run for the current ledger (tests wait on it). */
  seeded(): Promise<void>;
  /** Write a snapshot now if the ledger changed; the key written, or null. */
  snapshot(force?: boolean): Promise<string | null>;
  /** Resolves once every store, fleet and pointer call the process started has settled. */
  idle(): Promise<void>;
  close(): Promise<void>;
}

/** What the composition takes from outside: the platform's adapters, or a test's stand-ins. */
export interface ControlPlaneDeps {
  store?: StoreDriver;
  snapshots?: SnapshotStore;
  programs?: DiscoveredProgram[];
  /** A fleet to use as is (tests); the image builds one through `coreFleet` when it gets a ledger. */
  cores?: CoreFleet;
  /** The platform's core fleet, wired by main.ts; absent, the machine runs on tabs alone. */
  coreFleet?: (config: CoreFleetConfig) => CoreFleet;
  /** Who the fleet's pointer names; absent (a laptop, most tests) the process is authoritative at once. */
  pointer?: PointerReader;
  /** The build stamp /health reports. */
  build?: BuildStamp;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

/**
 * The control-plane process (design §9.3): boots neutral, becomes a control plane at boot in
 * local mode or on the /run hook in the image, and from then on turns socket activity and timer
 * ticks into core events and core effects into socket sends and closes. This file only composes
 * the pieces; each of them takes what it needs as a parameter.
 */
export async function createControlPlane(
  config: Config,
  clock: Clock = systemClock,
  deps: ControlPlaneDeps = {},
): Promise<ControlPlane> {
  const startedAt = clock.now();
  const inflight = new Inflight();
  const state = createProcessState({
    clock,
    generation: config.generation,
    sessionUrl: config.sessionUrl,
  });
  const gateway = createSocketGateway({
    dispatch: (event) => state.dispatch(event),
    accepting: () => state.role === "control-plane" && state.ledger?.meta.phase === "active",
    log,
  });

  // The listeners come up before the routers exist (the store base needs the public port), so a
  // request in that window meets a 503 rather than a half-built process.
  const notReady: Handler = (_req, res) => sendJson(res, 503, { error: "starting" });
  const routes = { public: notReady, private: notReady };
  const publicServer = createServer(
    (req, res) => void Promise.resolve(routes.public(req, res)).catch((err) => fail(res, err)),
  );
  const privateServer = createServer(
    (req, res) => void Promise.resolve(routes.private(req, res)).catch((err) => fail(res, err)),
  );
  publicServer.on("upgrade", gateway.onUpgrade);
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

  const authority = createAuthority({
    readPointer: deps.pointer ?? null,
    self: () => state.microvmId,
    onGranted: () => state.dispatch({ kind: "tick" }),
    inflight,
    log,
  });
  const lifecycle = createLifecycle({
    state,
    config,
    clock,
    store,
    programs: deps.programs,
    cores: deps.cores,
    coreFleet: deps.coreFleet,
    inflight,
    log,
  });
  state.bind(
    createEffectExecutor({
      gateway,
      store,
      cores: lifecycle.cores,
      authoritative: () => authority.authoritative,
      resolve: createBundleResolver(store),
      dispatch: (event) => state.dispatch(event),
      ledger: () => state.ledger,
      generation: () => state.generation,
      inflight,
      log,
    }),
  );
  const snapshotWriter = createSnapshotWriter({ state, authority, snapshotter, clock, log });
  const rotation = createRotation({
    state,
    gateway,
    snapshots: snapshotWriter,
    authority,
    lifecycle,
    storeBase,
    rng: Math.random,
    clock,
    log,
  });
  const hookHost = createHookHost({
    state,
    snapshotter,
    snapshots: snapshotWriter,
    authority,
    lifecycle,
    storeBase,
    isListening: () => publicServer.listening && privateServer.listening,
    validate: selfTest,
    startCore: async (opts) => {
      const { startCore } = await import("./core-node.ts");
      startCore(opts);
    },
    log,
  });
  const view = () => ({
    role: state.role,
    phase: state.phase(),
    mode: config.mode,
    generation: state.generation,
    build: deps.build ?? null,
    imageVersion: lifecycle.imageVersion(),
    authoritative: authority.authoritative,
    ledger: state.ledger,
    snapshots: snapshotter.status,
    startedAt,
  });
  routes.private = createPrivateRouter({
    hookHost,
    rotation,
    health: () => healthReport(view(), clock.now()),
    diag: async () =>
      diagReport(
        {
          ...view(),
          storeBase: state.ledger?.meta.storeBase ?? storeBase,
          storeDriver: store === local ? "local" : "s3",
          localBlobs: local.size,
          programsDir: config.programsDir,
          sandboxWorker: process.env.TABFRAME_SANDBOX_WORKER ?? null,
        },
        await probeDiag(store, state.generation),
        clock.now(),
      ),
    snapshot: () => (state.ledger ? snapshotter.current(state.ledger) : null),
    gate: createFleetGate({
      role: () => state.role,
      secret: () => state.fleetSecret,
      open: config.mode !== "image" || config.allowOpenFleetRoutes === true,
    }),
    log,
  });
  routes.public = createPublicRouter({
    local: config.mode === "local" ? local : null,
    session: () =>
      config.mode === "local" && config.localOff
        ? { off: true }
        : {
            endpoint: `ws://${publicAddress.host}:${publicAddress.port}`,
            token: "local",
            expiresAt: clock.now() + 30 * 60_000,
            storeBase,
            generation: state.generation,
          },
    webDir: config.webDir,
  });

  const stopLoops = startLoops({
    state,
    config,
    lifecycle,
    snapshots: snapshotWriter,
    inflight,
    onLeaseExpired: () => rotation.leaseExpired(),
    log,
  });
  if (config.mode === "local" && !config.localNeutral)
    lifecycle.becomeControlPlane(storeBase, null);

  return {
    publicAddress,
    privateAddress,
    store,
    get role() {
      return state.role;
    },
    get generation() {
      return state.generation;
    },
    get ledger() {
      return state.ledger;
    },
    get snapshots() {
      return snapshotter.status;
    },
    get phase() {
      return state.phase();
    },
    seeded: () => lifecycle.seeded(),
    snapshot: (force = false) => snapshotWriter.probe(force),
    idle: () => inflight.settled(),
    async close() {
      stopLoops();
      authority.stop();
      state.close();
      gateway.terminateAll();
      await Promise.all([closeServer(publicServer), closeServer(privateServer)]);
      await inflight.settled();
    },
  };
}
