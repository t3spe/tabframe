import { describe, expect, test } from "bun:test";
import type { PlaceView } from "@tabframe/protocol";
import { PROTOCOL_VERSION } from "@tabframe/protocol";
import { sha256Hex } from "@tabframe/store/hash";
import { applyMessage, type ClusterState, emptyState } from "./state.ts";
import {
  type BlobSource,
  storeSource,
  type TileFlag,
  type TilePainter,
  TileView,
} from "./tiles.ts";

const env = { v: PROTOCOL_VERSION, gen: 1 } as const;

class Recorder implements TilePainter {
  calls: string[] = [];
  reset(w: number, h: number): void {
    this.calls.push(`reset ${w}x${h}`);
  }
  put(place: PlaceView, rgba: Uint8ClampedArray): void {
    this.calls.push(`put ${place.x},${place.y} ${place.w}x${place.h} ${rgba.length}`);
  }
  flag(place: PlaceView, flag: TileFlag): void {
    this.calls.push(`flag ${place.x},${place.y} ${flag}`);
  }
  clear(place: PlaceView): void {
    this.calls.push(`clear ${place.x},${place.y}`);
  }
}

class MemorySource implements BlobSource {
  blobs = new Map<string, Uint8Array>();
  requests: string[] = [];
  async get(hash: string): Promise<Uint8Array | null> {
    this.requests.push(hash);
    return this.blobs.get(hash) ?? null;
  }
}

const tile = (w: number, h: number, seed: number): Uint8Array => {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < out.length; i++) out[i] = (i * 7 + seed) & 0xff;
  return out;
};

async function frame(tiles: { id: string; index: number; bytes: Uint8Array; place: PlaceView }[]) {
  const src = new MemorySource();
  const hashes = new Map<string, string>();
  for (const t of tiles) {
    const h = await sha256Hex(t.bytes);
    hashes.set(t.id, h);
    src.blobs.set(h, t.bytes);
  }
  let state = applyMessage(emptyState(), {
    t: "snapshot",
    ...env,
    seq: 1,
    page: 0,
    pages: 1,
    nodes: [],
    execution: {
      executionId: "e1",
      program: "b".repeat(64),
      programName: "mandelbrot",
      status: "running",
      human: false,
      view: "tiles",
      params: {},
      stage: 0,
      stageName: "render",
      taskCount: tiles.length,
      canvas: { w: 128, h: 64 },
      root: null,
      counters: {
        pending: tiles.length,
        assigned: 0,
        done: 0,
        failed: 0,
        reassigned: 0,
        speculated: 0,
        verified: 0,
        mismatched: 0,
      },
      startedAt: 0,
    },
    queue: [],
    tasks: tiles.map((t) => ({
      taskId: t.id,
      executionId: "e1",
      stage: 0,
      index: t.index,
      kind: "run" as const,
      status: "pending" as const,
      holders: [],
      attempts: 0,
      output: null,
      place: t.place,
      contested: false,
    })),
    at: 0,
  });
  let seq = 1;
  const done = (id: string, hash = hashes.get(id) as string) => {
    seq += 1;
    state = applyMessage(state, {
      t: "taskDone",
      ...env,
      seq,
      taskId: id,
      nodeId: "n1",
      output: hash,
      place: tiles.find((t) => t.id === id)?.place ?? null,
      computeMs: 1,
    });
    return state;
  };
  const mismatch = (id: string) => {
    seq += 1;
    state = applyMessage(state, { t: "taskMismatch", ...env, seq, taskId: id, nodeId: "n2" });
    return state;
  };
  return {
    src,
    hashes,
    done,
    mismatch,
    get state() {
      return state;
    },
  };
}

const settle = async (_view: TileView, until: () => boolean, tries = 200) => {
  for (let i = 0; i < tries && !until(); i++) await new Promise((r) => setTimeout(r, 2));
};

describe("tile view", () => {
  test("paints verified tiles once, flags bad bytes, and clears on a new frame", async () => {
    const a = tile(64, 64, 1);
    const b = tile(64, 64, 2);
    const f = await frame([
      { id: "t1", index: 0, bytes: a, place: { x: 0, y: 0, w: 64, h: 64 } },
      { id: "t2", index: 1, bytes: b, place: { x: 64, y: 0, w: 64, h: 64 } },
    ]);
    const painter = new Recorder();
    const view = new TileView(f.src, painter, { concurrency: 1 });
    let changes = 0;
    view.onChange = () => changes++;
    view.sync(f.state);
    expect(painter.calls).toEqual(["reset 128x64"]);
    view.sync(f.done("t1"));
    await settle(view, () => view.paintedCount === 1);
    expect(painter.calls).toContain("put 0,0 64x64 16384");
    // The same state again fetches nothing more.
    view.sync(f.state);
    view.sync(f.state);
    await settle(view, () => view.stats.inFlight === 0);
    expect(f.src.requests.length).toBe(1);
    // Serving other bytes under the hash is refused with an outline.
    f.src.blobs.set(f.hashes.get("t2") as string, tile(64, 64, 9));
    view.sync(f.done("t2"));
    await settle(view, () => view.flags.size === 1);
    expect(view.flags.get("t2")).toBe("bad-hash");
    expect(painter.calls.at(-1)).toBe("flag 64,0 bad-hash");
    expect(view.stats).toMatchObject({ fetched: 2, painted: 1, flagged: 1, inFlight: 0 });
    expect(changes).toBeGreaterThanOrEqual(3);
    // A new stage resets the surface and forgets everything.
    const next = applyMessage(f.state, {
      t: "stageStarted",
      ...env,
      seq: f.state.seq + 1,
      executionId: "e1",
      stage: 1,
      name: "again",
      taskCount: 1,
      canvas: { w: 32, h: 32 },
      tasks: [],
    });
    view.sync(next);
    expect(painter.calls.at(-1)).toBe("reset 32x32");
    expect(view.paintedCount).toBe(0);
    expect(view.flags.size).toBe(0);
  });
  test("wrong sizes and missing blobs are flagged; missing ones are retried after the delay", async () => {
    const short = tile(8, 8, 3);
    const f = await frame([
      { id: "t1", index: 0, bytes: short, place: { x: 0, y: 0, w: 64, h: 64 } },
      { id: "t2", index: 1, bytes: tile(64, 64, 4), place: { x: 64, y: 0, w: 64, h: 64 } },
    ]);
    const painter = new Recorder();
    let clock = 1_000;
    const view = new TileView(f.src, painter, { retryAfterMs: 500, now: () => clock });
    view.sync(f.state);
    view.sync(f.done("t1"));
    await settle(view, () => view.flags.size === 1);
    expect(view.flags.get("t1")).toBe("bad-size");
    const missing = f.hashes.get("t2") as string;
    f.src.blobs.delete(missing);
    view.sync(f.done("t2"));
    await settle(view, () => view.flags.size === 2);
    expect(view.flags.get("t2")).toBe("missing");
    // Too soon: no second request.
    view.sync(f.state);
    await settle(view, () => view.stats.inFlight === 0);
    expect(f.src.requests.filter((h) => h === missing).length).toBe(1);
    // After the delay the blob has landed and paints.
    clock += 600;
    f.src.blobs.set(missing, tile(64, 64, 4));
    view.sync(f.state);
    await settle(view, () => view.paintedCount === 1);
    expect(view.flags.size).toBe(1);
    expect(painter.calls.at(-1)).toBe("put 64,0 64x64 16384");
  });
  test("a retraction wipes the rectangle, and a recompute repaints under the new hash", async () => {
    const f = await frame([
      { id: "t1", index: 0, bytes: tile(64, 64, 5), place: { x: 0, y: 0, w: 64, h: 64 } },
    ]);
    const painter = new Recorder();
    const view = new TileView(f.src, painter);
    view.sync(f.state);
    view.sync(f.done("t1"));
    await settle(view, () => view.paintedCount === 1);
    view.sync(f.mismatch("t1"));
    expect(painter.calls.at(-1)).toBe("clear 0,0");
    expect(view.paintedCount).toBe(0);
    const again = tile(64, 64, 6);
    const h = await sha256Hex(again);
    f.src.blobs.set(h, again);
    view.sync(f.done("t1", h));
    await settle(view, () => view.paintedCount === 1);
    expect(f.src.requests.at(-1)).toBe(h);
  });
  test("a fetch that throws counts as missing; a frame change mid-flight drops the result", async () => {
    const f = await frame([
      { id: "t1", index: 0, bytes: tile(64, 64, 7), place: { x: 0, y: 0, w: 64, h: 64 } },
    ]);
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow: BlobSource = {
      async get(hash) {
        await gate;
        if (hash === "boom") throw new Error("network");
        return f.src.get(hash);
      },
    };
    const painter = new Recorder();
    const view = new TileView(slow, painter);
    view.sync(f.state);
    view.sync(f.done("t1"));
    expect(view.stats.inFlight).toBe(1);
    const other = applyMessage(emptyState(), {
      t: "snapshot",
      ...env,
      seq: 50,
      page: 0,
      pages: 1,
      nodes: [],
      execution: null,
      tasks: [],
      at: 0,
    });
    view.sync(other);
    (release as unknown as () => void)();
    await settle(view, () => view.stats.fetched === 1, 50);
    expect(view.stats.fetched).toBe(0);
    expect(painter.calls.filter((c) => c.startsWith("put")).length).toBe(0);
    // Errors from the source flag the tile as missing.
    const throwing: BlobSource = {
      async get() {
        throw new Error("network");
      },
    };
    const view2 = new TileView(throwing, new Recorder());
    view2.sync(f.state);
    await settle(view2, () => view2.flags.size === 1);
    expect(view2.flags.get("t1")).toBe("missing");
  });
  test("frameKey is null without a tiles execution; storeSource builds urls and maps statuses", async () => {
    const empty: ClusterState = emptyState();
    expect(TileView.frameKey(empty)).toBeNull();
    const f = await frame([]);
    expect(TileView.frameKey(f.state)).toBe("e1/0/128x64");
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(url);
      if (url.endsWith("/missing")) return new Response(null, { status: 404 });
      if (url.endsWith("/private")) return new Response(null, { status: 403 });
      if (url.endsWith("/broken")) return new Response(null, { status: 500 });
      return new Response(new Uint8Array([1, 2, 3]));
    }) as unknown as typeof fetch;
    const src = storeSource("https://cdn.example/blob/", fake);
    expect(await src.get("missing")).toBeNull();
    expect(await src.get("private")).toBeNull();
    await expect(src.get("broken")).rejects.toThrow("blob 500");
    expect([...((await src.get("ok")) as Uint8Array)]).toEqual([1, 2, 3]);
    expect(seen[0]).toBe("https://cdn.example/blob/missing");
  });
});
