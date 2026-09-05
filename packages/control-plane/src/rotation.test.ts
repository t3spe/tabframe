// The control plane's rotation routes against two real processes in image mode: handover, adopt,
// drain, and the fleet secret that gates them (design §9.3, §9.4).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HANDOVER_LEASE_MS } from "@tabframe/core";
import { CLOSE, PROTOCOL_VERSION } from "@tabframe/protocol";
import { LocalStore, MemorySnapshots } from "@tabframe/store";
import { buildFixturePrograms } from "./fixtures.ts";
import { discoverPrograms } from "./seed.ts";
import { type ControlPlane, createControlPlane } from "./server.ts";
import { privateUrl, runHook, testConfig, until } from "./testing.ts";

const SECRET = "fleet-secret-for-the-test";
const imageConfig = testConfig();

const planes: ControlPlane[] = [];
let programsDir = "";
const store = new LocalStore("http://s/blob");

beforeAll(async () => {
  programsDir = await buildFixturePrograms();
}, 60_000);
afterAll(async () => {
  for (const cp of planes) await cp.close();
});

async function boot(generation: number, seed = true): Promise<ControlPlane> {
  const cp = await createControlPlane({ ...imageConfig, generation }, undefined, {
    store,
    snapshots: new MemorySnapshots(),
    programs: seed ? discoverPrograms(programsDir) : [],
  });
  planes.push(cp);
  return cp;
}

const priv = privateUrl;

async function run(cp: ControlPlane, generation: number): Promise<void> {
  const res = await runHook(
    cp,
    { role: "control-plane", generation, snapshotKey: null, fleetSecret: SECRET },
    `vm-${generation}`,
  );
  expect(res.status).toBe(200);
}

const withSecret = (secret = SECRET) => ({ "x-tabframe-fleet-secret": secret });

/** A node socket that says hello and stays quiet, so a rotation has a client to move. */
function openNode(
  cp: ControlPlane,
  gen: number,
): Promise<{ ws: WebSocket; closed: Promise<{ code: number; reason: string }> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${cp.publicAddress.port}/node`);
    const closed = new Promise<{ code: number; reason: string }>((res) => {
      ws.onclose = (e) => res({ code: e.code, reason: e.reason });
    });
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          t: "hello",
          v: PROTOCOL_VERSION,
          gen,
          hostId: "h1",
          kind: "tab",
          cores: 4,
          sandboxVersion: "1",
        }),
      );
      resolve({ ws, closed });
    };
    ws.onerror = () => reject(new Error("node socket failed"));
  });
}

describe("rotation", () => {
  test("handover, adopt, drain: the successor has the ledger and the clients are told where to go", async () => {
    const first = await boot(4);
    await run(first, 4);
    await first.seeded();
    expect(first.phase).toBe("active");
    const node = await openNode(first, 4);
    await Bun.sleep(100);
    expect(first.ledger?.nodes.size).toBe(1);
    const programs = first.ledger?.programs.size ?? 0;
    expect(programs).toBe(1);

    // Step 2: handover.
    const handover = await fetch(priv(first, "/handover"), {
      method: "POST",
      headers: withSecret(),
    });
    expect(handover.status).toBe(200);
    const body = (await handover.json()) as { generation: number; ledger: Record<string, unknown> };
    expect(body.generation).toBe(4);
    expect(first.phase).toBe("handing-over");
    // A handing-over control plane takes no new clients.
    await expect(openNode(first, 4)).rejects.toThrow();

    // Step 3: adopt into a fresh process.
    const second = await boot(5, false);
    await run(second, 5);
    const adopt = await fetch(priv(second, "/adopt"), {
      method: "POST",
      headers: withSecret(),
      body: JSON.stringify(body.ledger),
    });
    expect(adopt.status).toBe(200);
    expect(await adopt.json()).toEqual({ adopted: true, generation: 5 });
    expect(second.phase).toBe("active");
    expect(second.ledger?.programs.size).toBe(programs);
    // Adopting marks every node gone: they belong to the previous generation's sockets.
    expect(second.ledger?.nodes.size).toBe(0);
    // A retried rotation adopts the same ledger again, and that is safe.
    const again = await fetch(priv(second, "/adopt"), {
      method: "POST",
      headers: withSecret(),
      body: JSON.stringify(body.ledger),
    });
    expect(again.status).toBe(200);
    expect(second.ledger?.programs.size).toBe(programs);
    // A ledger from a later generation is a rollback and is refused.
    const newer = await fetch(priv(second, "/adopt"), {
      method: "POST",
      headers: withSecret(),
      body: JSON.stringify({
        ...body.ledger,
        meta: { ...(body.ledger.meta as object), generation: 99 },
      }),
    });
    expect(newer.status).toBe(409);

    // Step 5: drain the old one; the node is closed with the rotating code and a delay.
    const drain = await fetch(priv(first, "/drain"), {
      method: "POST",
      headers: withSecret(),
      body: JSON.stringify({ next: 5 }),
    });
    expect(drain.status).toBe(200);
    expect((await drain.json()) as { drained: number }).toMatchObject({ drained: 1, next: 5 });
    const close = await node.closed;
    expect(close.code).toBe(CLOSE.rotatingReconnect);
    const reason = JSON.parse(close.reason) as {
      gen: number;
      next: number;
      reconnectAfterMs: number;
    };
    expect(reason).toMatchObject({ gen: 4, next: 5 });
    expect(reason.reconnectAfterMs).toBeGreaterThanOrEqual(0);
    expect(first.phase).toBe("drained");
  }, 30_000);

  test("the fleet routes need the secret from the run payload", async () => {
    const cp = await boot(9, false);
    await run(cp, 9);
    for (const path of ["/handover", "/adopt", "/drain"]) {
      const res = await fetch(priv(cp, path), { method: "POST" });
      expect(res.status).toBe(403);
      const wrong = await fetch(priv(cp, path), {
        method: "POST",
        headers: withSecret("not-the-secret-at-all-x"),
      });
      expect(wrong.status).toBe(403);
    }
    // /health stays open: it carries counts and the operator scripts poll it.
    expect((await fetch(priv(cp, "/health"))).status).toBe(200);
    // /snapshot and /diag are gated with the rest.
    expect((await fetch(priv(cp, "/snapshot"))).status).toBe(403);
    expect((await fetch(priv(cp, "/snapshot"), { headers: withSecret() })).status).toBe(200);
  }, 30_000);

  test("adopt refuses a ledger it cannot read, and a neutral process can adopt one", async () => {
    const neutral = await boot(11, false);
    await run(neutral, 11);
    const bad = await fetch(priv(neutral, "/adopt"), {
      method: "POST",
      headers: withSecret(),
      body: "{not json",
    });
    expect(bad.status).toBe(400);
    expect(neutral.phase).toBe("active");
  }, 30_000);
});

describe("lease expiry", () => {
  test("a control plane whose lease ran out drains and terminates itself when the pointer names a newer generation", async () => {
    let t = 1_000_000;
    const clock = { now: () => t };
    const terminated: string[] = [];
    const cp = await createControlPlane({ ...imageConfig, generation: 3 }, clock, {
      store,
      snapshots: new MemorySnapshots(),
      programs: [],
      cores: {
        launch: async () => ({ microvmId: "core-x", token: "t" }),
        terminate: async (id) => {
          terminated.push(id);
        },
        gone: async () => [],
      },
      pointer: async () => ({ microvmId: "vm-9", generation: 9 }),
    });
    planes.push(cp);
    await run(cp, 3);
    const handover = await fetch(priv(cp, "/handover"), { method: "POST", headers: withSecret() });
    expect(handover.status).toBe(200);
    expect(cp.phase).toBe("handing-over");
    // The rotation died after the flip: nobody drains this one. The lease runs out.
    t += HANDOVER_LEASE_MS + 1_000;
    await until(() => cp.phase === "drained", 5_000, "the superseded control plane to drain");
    await cp.idle();
    expect(terminated).toEqual(["vm-3"]);
  });

  test("a lease that runs out while the pointer still names this control plane carries on", async () => {
    let t = 2_000_000;
    const clock = { now: () => t };
    const terminated: string[] = [];
    const cp = await createControlPlane({ ...imageConfig, generation: 4 }, clock, {
      store,
      snapshots: new MemorySnapshots(),
      programs: [],
      cores: {
        launch: async () => ({ microvmId: "core-x", token: "t" }),
        terminate: async (id) => {
          terminated.push(id);
        },
        gone: async () => [],
      },
      pointer: async () => ({ microvmId: "vm-4", generation: 4 }),
    });
    planes.push(cp);
    await run(cp, 4);
    expect(
      (await fetch(priv(cp, "/handover"), { method: "POST", headers: withSecret() })).status,
    ).toBe(200);
    t += HANDOVER_LEASE_MS + 1_000;
    await until(
      () => cp.phase === "active",
      2_000,
      "the lease to run out and the tick to carry on",
    );
    await cp.idle();
    expect(terminated).toEqual([]);
  });
});

describe("standby until named", () => {
  test("a control plane the pointer does not name is not authoritative until it is", async () => {
    let named = "vm-9";
    const cp = await createControlPlane({ ...imageConfig, generation: 6 }, undefined, {
      store,
      snapshots: new MemorySnapshots(),
      programs: [],
      cores: {
        launch: async () => ({ microvmId: "core-x", token: "t" }),
        terminate: async () => {},
        gone: async () => [],
      },
      pointer: async () => ({ microvmId: named, generation: 6 }),
    });
    planes.push(cp);
    await run(cp, 6);
    const health = async () =>
      (await (await fetch(priv(cp, "/health"))).json()) as { authoritative: boolean };
    expect((await health()).authoritative).toBe(false);
    // The pointer flips to this process: the next poll notices.
    named = "vm-6";
    await until(
      async () => (await health()).authoritative,
      8_000,
      "the pointer to name this process",
      100,
    );
  }, 15_000);
});
