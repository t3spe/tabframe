import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { createLedger, serializeLedger } from "@tabframe/core";
import { LocalStore, MemorySnapshots } from "@tabframe/store";
import type { Config } from "./config.ts";
import { buildFixturePrograms } from "./fixtures.ts";
import { discoverPrograms } from "./seed.ts";
import { type ControlPlane, createControlPlane } from "./server.ts";
import { LATEST_KEY, snapshotKey } from "./snapshotter.ts";

const H = (c: string) => c.repeat(64);
const imageConfig: Config = {
  mode: "image",
  publicPort: 0,
  privatePort: 0,
  host: "127.0.0.1",
  generation: 1,
  storeBase: null,
  webDir: null,
  blobBucket: null,
  localOff: false,
  localNeutral: false,
  tickMs: 50,
  programsDir: null,
  defaultProgram: "mandelbrot",
  snapshotBucket: null,
  snapshotEveryMs: 60_000,
  imageArn: null,
  imageVersion: null,
  coreRoleArn: null,
  region: "us-west-2",
  sessionUrl: null,
};

let programsDir = "";
beforeAll(async () => {
  programsDir = await buildFixturePrograms();
}, 60_000);

async function run(cp: ControlPlane, payload: Record<string, unknown>) {
  const res = await fetch(
    `http://127.0.0.1:${cp.privateAddress.port}/aws/lambda-microvms/runtime/v1/run`,
    {
      method: "POST",
      body: JSON.stringify({ microvmId: "vm-1", runHookPayload: JSON.stringify(payload) }),
    },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("adopt from snapshot on /run", () => {
  const cps: ControlPlane[] = [];
  afterAll(async () => {
    for (const cp of cps) await cp.close();
  });

  test("a named snapshot is adopted: programs and executions survive, nodes are gone, generation moves", async () => {
    const snapshots = new MemorySnapshots();
    const old = createLedger(4, { storeBase: "https://cdn.test/blob" });
    old.programs.set(H("b"), {
      bundle: H("b"),
      module: H("d"),
      manifest: { name: "demo", view: "tiles", persist: false, defaultParams: {} },
      files: {},
      addedAt: 1,
    });
    old.config.defaultLoop = { bundle: H("b"), params: {} };
    old.nodes.set("n1", {
      nodeId: "n1",
      connId: "c1",
      hostId: "h1",
      kind: "tab",
      cores: 4,
      sandboxVersion: "1",
      joinedAt: 1,
      lastSeen: 1,
      visible: true,
      health: "fast",
      inFlight: [],
      tasksDone: 3,
      lastTaskMs: 5,
      ewmaMs: 5,
      microvmId: null,
    } as never);
    const key = snapshotKey(4, 1_000);
    await snapshots.write(key, new TextEncoder().encode(serializeLedger(old)));

    const cp = await createControlPlane(imageConfig, undefined, {
      store: new LocalStore("http://s/blob"),
      snapshots,
      programs: [],
    });
    cps.push(cp);
    expect(cp.role).toBe("neutral");
    const r = await run(cp, {
      role: "control-plane",
      generation: 5,
      snapshotKey: key,
      storeBase: "https://cdn.test/blob",
    });
    expect(r.status).toBe(200);
    expect(cp.role).toBe("control-plane");
    expect(cp.generation).toBe(5);
    await cp.seeded();
    expect(cp.ledger?.programs.size).toBe(1); // adopted, not reseeded (no programs injected anyway)
    expect(cp.ledger?.nodes.size).toBe(0);
    expect(cp.ledger?.meta.generation).toBe(5);
    expect(cp.ledger?.config.defaultLoop?.bundle).toBe(H("b"));
    // A second /run is refused.
    const again = await run(cp, { role: "control-plane", generation: 6, snapshotKey: null });
    expect(again.status).toBe(400);
  });

  test("a missing snapshot key starts fresh and seeds the shipped programs; hooks write snapshots", async () => {
    const snapshots = new MemorySnapshots();
    const cp = await createControlPlane(imageConfig, undefined, {
      store: new LocalStore("http://s/blob"),
      snapshots,
      programs: discoverPrograms(programsDir),
    });
    cps.push(cp);
    const r = await run(cp, {
      role: "control-plane",
      generation: 2,
      snapshotKey: "g1/never-written.json.gz",
    });
    expect(r.status).toBe(200);
    await cp.seeded();
    expect(cp.ledger?.programs.size).toBe(1);
    const program = [...(cp.ledger?.programs.values() ?? [])][0];
    expect(program?.manifest.name).toBe("mandelbrot");
    expect(cp.ledger?.config.defaultLoop).toEqual({
      bundle: program?.bundle as string,
      params: { preset: 0, palette: "ocean" },
    });
    // The module and the bundle are in the store.
    expect(await cp.store.exists(program?.module as string)).toBe(true);
    expect(await cp.store.exists(program?.bundle as string)).toBe(true);

    // The suspend hook forces a write, gzipped, plus the latest pointer. (The periodic writer is
    // set to a minute here, so this counts a delta rather than assuming none has fired.)
    const writesBefore = cp.snapshots.writes;
    const res = await fetch(
      `http://127.0.0.1:${cp.privateAddress.port}/aws/lambda-microvms/runtime/v1/suspend`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    expect(cp.snapshots.writes).toBe(writesBefore + 1);
    expect(cp.snapshots.lastKey?.startsWith("g2/")).toBe(true);
    const latest = await snapshots.read(LATEST_KEY);
    expect(latest).not.toBeNull();
    const json = JSON.parse(gunzipSync(latest as Uint8Array).toString("utf8")) as {
      programs: unknown[];
      meta: { generation: number };
    };
    expect(json.programs.length).toBe(1);
    expect(json.meta.generation).toBe(2);
    // Unchanged ledger: the periodic write is a no-op; forced writes always go through.
    expect(await cp.snapshot()).toBeNull();
    expect(await cp.snapshot(true)).not.toBeNull();
    expect(cp.snapshots.writes).toBe(writesBefore + 2);
    // The private route serves the current ledger as JSON.
    const snap = await fetch(`http://127.0.0.1:${cp.privateAddress.port}/snapshot`);
    expect(snap.status).toBe(200);
    expect(((await snap.json()) as { programs: unknown[] }).programs.length).toBe(1);
    // Health reports the counts.
    const health = (await (
      await fetch(`http://127.0.0.1:${cp.privateAddress.port}/health`)
    ).json()) as Record<string, unknown>;
    expect(health.programs).toBe(1);
    expect((health.snapshots as { writes: number }).writes).toBe(writesBefore + 2);
  });

  test("an unreadable snapshot also starts fresh", async () => {
    const snapshots = new MemorySnapshots();
    await snapshots.write("bad", new TextEncoder().encode("{not json"));
    const cp = await createControlPlane(imageConfig, undefined, {
      store: new LocalStore("http://s/blob"),
      snapshots,
      programs: [],
    });
    cps.push(cp);
    const r = await run(cp, { role: "control-plane", generation: 3, snapshotKey: "bad" });
    expect(r.status).toBe(200);
    expect(cp.role).toBe("control-plane");
    expect(cp.ledger?.programs.size).toBe(0);
  });
});
