import { describe, expect, test } from "bun:test";
import { BlobCache, MISSING_RETRY_MS } from "./blob-cache.ts";
import type { BlobSource } from "./tiles.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A source whose answers the test chooses per hash: bytes, null (not there), or a throw. */
class Source implements BlobSource {
  blobs = new Map<string, Uint8Array | null | Error>();
  requests: string[] = [];
  async get(hash: string): Promise<Uint8Array | null> {
    this.requests.push(hash);
    const v = this.blobs.get(hash);
    if (v instanceof Error) throw v;
    return v ?? null;
  }
}

function harness(budget?: number) {
  const source = new Source();
  let now = 100_000;
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  let changes = 0;
  const cache = new BlobCache(
    () => source,
    () => changes++,
    {
      now: () => now,
      schedule: (fn, ms) => void scheduled.push({ fn, ms }),
      ...(budget === undefined ? {} : { budgetBytes: budget }),
    },
  );
  return {
    source,
    cache,
    scheduled,
    get changes() {
      return changes;
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("the blob cache", () => {
  test("a hash is fetched once; the landing bumps the version and asks for a render", async () => {
    const h = harness();
    h.source.blobs.set("a", new Uint8Array([1, 2, 3]));
    expect(h.cache.get("a")).toBe("pending");
    expect(h.cache.get("a")).toBe("pending");
    await tick();
    expect(h.cache.get("a")).toEqual(new Uint8Array([1, 2, 3]));
    expect(h.source.requests).toEqual(["a"]);
    expect(h.cache.version).toBe(1);
    expect(h.changes).toBe(1);
  });

  test("a miss stays pending for the retry window, bumps nothing, and is asked again after it", async () => {
    const h = harness();
    expect(h.cache.get("m")).toBe("pending");
    await tick();
    expect(h.cache.version).toBe(0);
    expect(h.changes).toBe(0);
    // One retry render is scheduled for when the window closes, and only one.
    expect(h.scheduled.map((s) => s.ms)).toEqual([MISSING_RETRY_MS + 50]);
    h.cache.get("m");
    expect(h.cache.get("m")).toBe("pending");
    await tick();
    expect(h.source.requests).toEqual(["m"]);
    expect(h.scheduled).toHaveLength(1);
    h.scheduled[0]?.fn();
    expect(h.cache.version).toBe(1);
    expect(h.changes).toBe(1);
    // The window closed: the next read asks the store again, and finds the blob this time.
    h.advance(MISSING_RETRY_MS);
    h.source.blobs.set("m", new Uint8Array([9]));
    expect(h.cache.get("m")).toBe("pending");
    await tick();
    expect(h.source.requests).toEqual(["m", "m"]);
    expect(h.cache.get("m")).toEqual(new Uint8Array([9]));
  });

  test("a fetch that throws reads as an error until the window closes, then is retried", async () => {
    const h = harness();
    h.source.blobs.set("e", new Error("network"));
    expect(h.cache.get("e")).toBe("pending");
    await tick();
    expect(h.cache.get("e")).toBe("error");
    expect(h.cache.version).toBe(1);
    expect(h.changes).toBe(1);
    expect(h.scheduled).toHaveLength(1);
    h.advance(MISSING_RETRY_MS - 1);
    expect(h.cache.get("e")).toBe("error");
    expect(h.source.requests).toEqual(["e"]);
    h.advance(1);
    h.source.blobs.set("e", new Uint8Array([4]));
    expect(h.cache.get("e")).toBe("pending");
    await tick();
    expect(h.cache.get("e")).toEqual(new Uint8Array([4]));
    expect(h.source.requests).toEqual(["e", "e"]);
  });

  test("the least recently used blobs are evicted past the budget; a touch keeps one", async () => {
    const h = harness(10);
    for (const [k, n] of [
      ["a", 4],
      ["b", 4],
    ] as const) {
      h.source.blobs.set(k, new Uint8Array(n));
      h.cache.get(k);
    }
    await tick();
    expect(h.cache.get("a")).toHaveLength(4); // touched: "b" is now the oldest
    h.source.blobs.set("c", new Uint8Array(4));
    h.cache.get("c");
    await tick();
    expect(h.cache.get("c")).toHaveLength(4);
    expect(h.cache.get("a")).toHaveLength(4);
    expect(h.source.requests).toEqual(["a", "b", "c"]);
    // "b" went: reading it fetches again.
    expect(h.cache.get("b")).toBe("pending");
    await tick();
    expect(h.source.requests).toEqual(["a", "b", "c", "b"]);
  });
});
