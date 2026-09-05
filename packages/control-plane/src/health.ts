import { promises as dns } from "node:dns";
import type { Ledger } from "@tabframe/core";
import { PROTOCOL_VERSION } from "@tabframe/protocol";
import type { StoreDriver } from "@tabframe/store";
import type { Mode, Role } from "./config.ts";
import type { SnapshotStatus } from "./snapshotter.ts";
import type { Phase } from "./state.ts";

/** The build the image was staged with: the whole stamp, a bare sha, or nothing (a local run). */
export type BuildStamp = Record<string, unknown> | string | null;

/** The build the environment names: the whole stamp as JSON, else a bare sha, else nothing. */
export function buildStamp(env: NodeJS.ProcessEnv): BuildStamp {
  const whole = env.TABFRAME_BUILD_JSON;
  if (whole) {
    try {
      return JSON.parse(whole) as Record<string, unknown>;
    } catch {
      // fall through to the short form
    }
  }
  return env.TABFRAME_BUILD ?? null;
}

export interface HealthView {
  role: Role;
  phase: Phase;
  mode: Mode;
  generation: number;
  build: BuildStamp;
  imageVersion: string | null;
  authoritative: boolean;
  ledger: Ledger | null;
  snapshots: SnapshotStatus;
  startedAt: number;
}

/** What /health answers; the runbook documents these keys, and the fleet client reads role and generation. */
export interface HealthReport {
  ok: true;
  role: Role;
  phase: Phase;
  mode: Mode;
  generation: number;
  protocol: number;
  build: BuildStamp;
  imageVersion: string | null;
  authoritative: boolean;
  awake: boolean | null;
  sleepReason: string | null;
  nodes: number;
  nodesByKind: { tab: number; core: number };
  cores: Array<{ microvmId: string; ageMs: number; linked: boolean }>;
  cloudCores: boolean;
  observers: number;
  programs: string[];
  running: Ledger["running"] | null;
  queue: number;
  executions: number;
  tasks: number;
  loopBackoffMs: number;
  snapshots: SnapshotStatus;
  uptimeMs: number;
}

/** Everything an operator needs at a glance and nothing a browser could not learn from the dashboard. */
export function healthReport(view: HealthView, now: number): HealthReport {
  const ledger = view.ledger;
  const nodes = [...(ledger?.nodes.values() ?? [])];
  return {
    ok: true,
    role: view.role,
    phase: view.phase,
    mode: view.mode,
    generation: view.generation,
    protocol: PROTOCOL_VERSION,
    build: view.build,
    imageVersion: view.imageVersion,
    authoritative: view.authoritative,
    awake: ledger?.meta.awake ?? null,
    sleepReason: ledger?.meta.sleepReason ?? null,
    nodes: nodes.length,
    nodesByKind: {
      tab: nodes.filter((n) => n.kind === "tab").length,
      core: nodes.filter((n) => n.kind === "core").length,
    },
    // The tail only: the whole id is what an impostor would need, and /health answers any holder
    // of the private-port token.
    cores: [...(ledger?.cores.values() ?? [])].map((c) => ({
      microvmId: `…${c.microvmId.slice(-8)}`,
      ageMs: now - c.launchedAt,
      linked: c.nodeId !== null,
    })),
    cloudCores: ledger?.config.cloudCores ?? false,
    observers: ledger?.observers.size ?? 0,
    programs: [...(ledger?.programs.values() ?? [])]
      .filter((p) => !p.retired)
      .map((p) => p.manifest.name),
    running: ledger?.running ?? null,
    queue: ledger?.queue.length ?? 0,
    executions: ledger?.executions.size ?? 0,
    tasks: ledger?.tasks.size ?? 0,
    loopBackoffMs: ledger?.meta.loopBackoffMs ?? 0,
    snapshots: view.snapshots,
    uptimeMs: now - view.startedAt,
  };
}

export interface DiagProbes {
  dns: string;
  store: string;
}

/** The store round trip proves credentials, the bucket, and the network in one call. */
export async function probeDiag(store: StoreDriver, generation: number): Promise<DiagProbes> {
  const t0 = Date.now();
  let dnsResult: string;
  try {
    const addrs = await dns.resolve4("s3.us-west-2.amazonaws.com");
    dnsResult = `ok (${addrs.length} addresses, ${Date.now() - t0} ms)`;
  } catch (err) {
    dnsResult = `failed: ${String(err)}`;
  }
  let storeResult: string;
  const t1 = Date.now();
  try {
    const probe = new TextEncoder().encode(`diag ${generation}`);
    const hash = await store.put(probe);
    const back = await store.get(hash);
    storeResult = back
      ? `ok (put and get ${probe.length} bytes in ${Date.now() - t1} ms)`
      : "put succeeded but get returned nothing";
  } catch (err) {
    storeResult = `failed: ${String(err).slice(0, 160)}`;
  }
  return { dns: dnsResult, store: storeResult };
}

export interface DiagView
  extends Pick<HealthView, "role" | "phase" | "generation" | "ledger" | "snapshots" | "startedAt"> {
  storeBase: string;
  storeDriver: "local" | "s3";
  localBlobs: number;
  programsDir: string | null;
  sandboxWorker: string | null;
}

export interface DiagReport {
  dns: string;
  store: string;
  storeBase: string;
  storeDriver: "local" | "s3";
  localBlobs: number;
  snapshots: SnapshotStatus;
  role: Role;
  generation: number;
  phase: Phase;
  node: string;
  memoryMiB: { rss: number; heapUsed: number };
  uptimeMs: number;
  env: { programsDir: string | null; sandboxWorker: string | null; cloudCores: boolean };
}

export function diagReport(view: DiagView, probes: DiagProbes, now: number): DiagReport {
  const mem = process.memoryUsage();
  return {
    dns: probes.dns,
    store: probes.store,
    storeBase: view.storeBase,
    storeDriver: view.storeDriver,
    localBlobs: view.localBlobs,
    snapshots: view.snapshots,
    role: view.role,
    generation: view.generation,
    phase: view.phase,
    node: process.version,
    memoryMiB: {
      rss: Math.round(mem.rss / 1048576),
      heapUsed: Math.round(mem.heapUsed / 1048576),
    },
    uptimeMs: now - view.startedAt,
    env: {
      programsDir: view.programsDir,
      sandboxWorker: view.sandboxWorker,
      cloudCores: view.ledger?.config.cloudCores ?? false,
    },
  };
}
