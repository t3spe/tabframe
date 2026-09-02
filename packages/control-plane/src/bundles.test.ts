import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BUNDLE_PATHS, canonicalStringify, type FsManifest } from "@tabframe/protocol";
import { LocalStore } from "@tabframe/store";
import { MAX_BUNDLE_BYTES, resolveBundle } from "./bundles.ts";
import { buildFixturePrograms } from "./fixtures.ts";

const PAGES = 256;
let wasm: Uint8Array;
let manifestBytes: Uint8Array;

beforeAll(async () => {
  const dir = await buildFixturePrograms();
  wasm = new Uint8Array(readFileSync(path.join(dir, "mandelbrot", "program.wasm")));
  manifestBytes = new Uint8Array(readFileSync(path.join(dir, "mandelbrot", "manifest.json")));
}, 60_000);

/** Put a bundle in a store and return its hash, so a test can hand it to the resolver. */
async function upload(
  store: LocalStore,
  overrides: Partial<Record<string, { hash: string; size: number }>> = {},
  extra: FsManifest["files"] = {},
): Promise<string> {
  const module = await store.put(wasm);
  const manifest = await store.put(manifestBytes);
  const files: FsManifest["files"] = {
    [BUNDLE_PATHS.module]: { hash: module, size: wasm.length },
    [BUNDLE_PATHS.manifest]: { hash: manifest, size: manifestBytes.length },
    ...extra,
  };
  for (const [path, entry] of Object.entries(overrides)) {
    if (entry === undefined) delete files[path];
    else files[path] = entry;
  }
  return store.put(new TextEncoder().encode(canonicalStringify({ version: 1, files })));
}

describe("resolveBundle", () => {
  test("accepts a well-formed upload and reports the module, manifest, and files", async () => {
    const store = new LocalStore("http://s/blob");
    const corpus = new TextEncoder().encode("hello world");
    const corpusHash = await store.put(corpus);
    const bundle = await upload(
      store,
      {},
      { "/in/corpus.txt": { hash: corpusHash, size: corpus.length } },
    );
    const r = await resolveBundle(store, bundle, PAGES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.name).toBe("mandelbrot");
    expect(r.module).toBe(await store.put(wasm));
    expect(Object.keys(r.files).sort()).toEqual([
      "/in/corpus.txt",
      BUNDLE_PATHS.manifest,
      BUNDLE_PATHS.module,
    ]);
  });

  test("refuses a bundle that is not in the store, or is not a manifest", async () => {
    const store = new LocalStore("http://s/blob");
    const missing = await resolveBundle(store, "a".repeat(64), PAGES);
    expect(missing).toEqual({ ok: false, reason: "the bundle manifest is not in the store" });
    const junk = await store.put(new TextEncoder().encode("{not json"));
    const bad = await resolveBundle(store, junk, PAGES);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.reason).toContain("not a filesystem manifest");
  });

  test("refuses a missing module or program manifest, and blobs the store does not have", async () => {
    const store = new LocalStore("http://s/blob");
    const noModule = await upload(store, { [BUNDLE_PATHS.module]: undefined });
    expect((await resolveBundle(store, noModule, PAGES)) as { reason: string }).toMatchObject({
      ok: false,
      reason: `the bundle has no ${BUNDLE_PATHS.module}`,
    });
    const noManifest = await upload(store, { [BUNDLE_PATHS.manifest]: undefined });
    expect((await resolveBundle(store, noManifest, PAGES)) as { reason: string }).toMatchObject({
      ok: false,
      reason: `the bundle has no ${BUNDLE_PATHS.manifest}`,
    });
    const absent = await upload(store, {
      [BUNDLE_PATHS.module]: { hash: "b".repeat(64), size: 10 },
    });
    expect((await resolveBundle(store, absent, PAGES)) as { reason: string }).toMatchObject({
      ok: false,
      reason: "the module is not in the store",
    });
  });

  test("refuses files outside /in/, oversized bundles, and oversized modules", async () => {
    const store = new LocalStore("http://s/blob");
    const stray = await upload(store, {}, { "/out/0/0": { hash: "c".repeat(64), size: 1 } });
    expect((await resolveBundle(store, stray, PAGES)) as { reason: string }).toMatchObject({
      ok: false,
      reason: "/out/0/0 is outside /in/",
    });
    const huge = await upload(
      store,
      {},
      {
        "/in/big": { hash: "c".repeat(64), size: MAX_BUNDLE_BYTES },
      },
    );
    const r = await resolveBundle(store, huge, PAGES);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("cap is");
  });

  test("refuses a module the sandbox would refuse", async () => {
    const store = new LocalStore("http://s/blob");
    const bytes = new TextEncoder().encode("not a wasm module at all");
    const hash = await store.put(bytes);
    const bundle = await upload(store, { [BUNDLE_PATHS.module]: { hash, size: bytes.length } });
    const r = await resolveBundle(store, bundle, PAGES);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason.length).toBeGreaterThan(0);
    // A module that declares more memory than the cap is refused by the same check.
    const tight = await resolveBundle(store, await upload(store), 4);
    expect(tight.ok).toBe(false);
  });

  test("refuses a program manifest that does not parse", async () => {
    const store = new LocalStore("http://s/blob");
    const bad = new TextEncoder().encode(JSON.stringify({ name: "x", view: "nope" }));
    const hash = await store.put(bad);
    const bundle = await upload(store, {
      [BUNDLE_PATHS.manifest]: { hash, size: bad.length },
    });
    const r = await resolveBundle(store, bundle, PAGES);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("program manifest is invalid");
  });
});
