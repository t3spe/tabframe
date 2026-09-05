import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { apply, createLedger, type Ledger } from "@tabframe/core";
import { BUNDLE_PATHS, fsManifest, type ProgramManifest } from "@tabframe/protocol";
import { LocalStore } from "@tabframe/store";
import { buildFixturePrograms, PROGRAMS_DIR } from "./fixtures.ts";
import {
  discoverPrograms,
  reconcileSeed,
  type SeededProgram,
  STALE_DROP_MS,
  seedPrograms,
} from "./seed.ts";

let dir = "";
beforeAll(async () => {
  dir = await buildFixturePrograms();
  // A repo-layout program (dist/) with an input file, and a broken one.
  const repo = path.join(PROGRAMS_DIR, "..", "repo-layout");
  mkdirSync(path.join(repo, "wordy", "dist"), { recursive: true });
  mkdirSync(path.join(repo, "wordy", "in"), { recursive: true });
  copy(
    path.join(dir, "mandelbrot", "program.wasm"),
    path.join(repo, "wordy", "dist", "program.wasm"),
  );
  writeFileSync(
    path.join(repo, "wordy", "dist", "manifest.json"),
    JSON.stringify({ name: "wordy", view: "bars", defaultParams: { k: 1 } }),
  );
  writeFileSync(path.join(repo, "wordy", "in", "corpus.txt"), "hello hello world");
  mkdirSync(path.join(repo, "broken"), { recursive: true });
  writeFileSync(path.join(repo, "broken", "program.wasm"), "not a module");
  writeFileSync(
    path.join(repo, "broken", "manifest.json"),
    JSON.stringify({ name: "broken", view: "text" }),
  );
  mkdirSync(path.join(repo, "empty"), { recursive: true });
}, 60_000);

function copy(from: string, to: string): void {
  writeFileSync(to, readFileSync(from));
}

describe("discoverPrograms", () => {
  test("finds the image layout", () => {
    const found = discoverPrograms(dir);
    expect(found.map((p) => p.name)).toEqual(["mandelbrot"]);
    expect(found[0]?.manifest.view).toBe("tiles");
    expect(found[0]?.wasm.length).toBeGreaterThan(1000);
    expect(found[0]?.inputs).toEqual([]);
  });
  test("finds the repo layout with inputs, skips directories without a module, keeps broken modules for validation", () => {
    const found = discoverPrograms(path.join(PROGRAMS_DIR, "..", "repo-layout"));
    expect(found.map((p) => p.name)).toEqual(["broken", "wordy"]);
    const wordy = found[1];
    expect(wordy?.manifest.defaultParams).toEqual({ k: 1 });
    expect(wordy?.inputs.map((i) => i.path)).toEqual(["/in/corpus.txt"]);
  });
  test("a missing directory is empty", () => {
    expect(discoverPrograms("/nonexistent/dir")).toEqual([]);
  });
});

describe("seedPrograms", () => {
  test("stores module, manifest, and inputs; the bundle is a manifest blob of fixed paths; invalid modules are rejected", async () => {
    const store = new LocalStore("http://s/blob");
    const found = [
      ...discoverPrograms(dir),
      ...discoverPrograms(path.join(PROGRAMS_DIR, "..", "repo-layout")),
    ];
    const { seeded, rejected } = await seedPrograms(store, found);
    expect(rejected.map((r) => r.name)).toEqual(["broken"]);
    expect(seeded.map((p) => p.name)).toEqual(["mandelbrot", "wordy"]);
    const m = seeded[0];
    if (!m) throw new Error("no mandelbrot");
    const bundleBytes = await store.get(m.bundle);
    expect(bundleBytes).not.toBeNull();
    const manifest = fsManifest.parse(
      JSON.parse(new TextDecoder().decode(bundleBytes as Uint8Array)),
    );
    expect(Object.keys(manifest.files).sort()).toEqual([
      BUNDLE_PATHS.manifest,
      BUNDLE_PATHS.module,
    ]);
    expect(manifest.files[BUNDLE_PATHS.module]?.hash).toBe(m.module);
    expect(await store.exists(m.module)).toBe(true);
    const w = seeded[1];
    expect(Object.keys(w?.files ?? {}).sort()).toEqual([
      "/in/corpus.txt",
      BUNDLE_PATHS.manifest,
      BUNDLE_PATHS.module,
    ]);
    // The same module under two names is stored once; bundles differ.
    expect(w?.module).toBe(m.module);
    expect(w?.bundle).not.toBe(m.bundle);
  });
  test("a program's source goes into the store and the manifest names it; one without a source has none (WP7.6)", async () => {
    const store = new LocalStore("http://s/blob");
    const found = [
      ...discoverPrograms(dir),
      ...discoverPrograms(path.join(PROGRAMS_DIR, "..", "repo-layout")),
    ];
    expect(found.find((p) => p.name === "mandelbrot")?.source?.length).toBeGreaterThan(1000);
    expect(found.find((p) => p.name === "wordy")?.source).toBeUndefined();
    const { seeded } = await seedPrograms(store, found);
    const m = seeded.find((p) => p.name === "mandelbrot");
    if (!m?.manifest.source) throw new Error("mandelbrot has no source hash");
    expect(m.manifest.source).toMatch(/^[0-9a-f]{64}$/);
    const text = new TextDecoder().decode((await store.get(m.manifest.source)) as Uint8Array);
    expect(text).toContain("export function plan");
    // The bundle's /manifest.json blob carries the same hash, so a reader of the bundle finds it.
    const bundle = fsManifest.parse(
      JSON.parse(new TextDecoder().decode((await store.get(m.bundle)) as Uint8Array)),
    );
    const manifestEntry = bundle.files[BUNDLE_PATHS.manifest];
    if (!manifestEntry) throw new Error("no manifest entry");
    const stored = JSON.parse(
      new TextDecoder().decode((await store.get(manifestEntry.hash)) as Uint8Array),
    ) as { source?: string };
    expect(stored.source).toBe(m.manifest.source);
    // The source is not a file of the bundle: the program cannot see it.
    expect(Object.keys(m.files).some((f) => f.includes("source"))).toBe(false);
    expect(seeded.find((p) => p.name === "wordy")?.manifest.source).toBeUndefined();
  });
});

const H = (c: string) => c.repeat(64);
const NOW = 10 * 60 * 60 * 1000;
const manifestOf = (name: string): ProgramManifest => ({
  name,
  view: "tiles",
  persist: false,
  defaultParams: { preset: 0 },
});
const shipped = (name: string, bundle: string): SeededProgram => ({
  name,
  bundle,
  module: H("m"),
  manifest: manifestOf(name),
  files: {},
});
function record(ledger: Ledger, name: string, bundle: string, addedAt: number): void {
  ledger.programs.set(bundle, {
    bundle,
    module: H("m"),
    manifest: manifestOf(name),
    files: {},
    addedAt,
  });
}

describe("reconcileSeed", () => {
  test("adds unseen bundles, retires a shipped name's previous version and old unreferenced drops, and moves the loop", () => {
    const ledger = createLedger(1, { storeBase: "http://s/blob" }, 0);
    record(ledger, "mandelbrot", H("a"), 0);
    record(ledger, "fresh", H("b"), NOW - 60_000);
    record(ledger, "old", H("c"), NOW - 2 * STALE_DROP_MS);
    ledger.config.defaultLoop = { bundle: H("a"), params: {} };
    const { events, report } = reconcileSeed(ledger, [shipped("mandelbrot", H("d"))], {
      defaultProgram: "mandelbrot",
      now: NOW,
    });
    expect(events.map((e) => e.kind)).toEqual([
      "programAdded",
      "programRetired",
      "programRetired",
      "setDefaultLoop",
    ]);
    expect(report).toEqual({
      programs: [{ name: "mandelbrot", bundle: H("d").slice(0, 12) }],
      added: ["mandelbrot"],
      retired: [`mandelbrot@${H("a").slice(0, 12)}`],
      stale: [`old@${H("c").slice(0, 12)}`],
      defaultLoop: "mandelbrot",
      loopMoved: true,
    });
    for (const e of events) apply(ledger, e, NOW);
    const live = [...ledger.programs.values()]
      .filter((p) => !p.retired)
      .map((p) => p.manifest.name);
    expect(live.sort()).toEqual(["fresh", "mandelbrot"]);
    expect(ledger.config.defaultLoop).toEqual({ bundle: H("d"), params: { preset: 0 } });
  });

  test("a bundle already in the ledger is left alone, and a loop on a live program stays", () => {
    const ledger = createLedger(1, { storeBase: "http://s/blob" }, 0);
    record(ledger, "mandelbrot", H("d"), 0);
    ledger.config.defaultLoop = { bundle: H("d"), params: { preset: 3 } };
    const { events, report } = reconcileSeed(ledger, [shipped("mandelbrot", H("d"))], {
      defaultProgram: "mandelbrot",
      now: NOW,
    });
    expect(events).toEqual([]);
    expect(report.loopMoved).toBe(false);
    expect(report.added).toEqual([]);
  });

  test("a drop an execution still refers to is kept however old; the loop is set when there is none", () => {
    const ledger = createLedger(1, { storeBase: "http://s/blob" }, 0);
    record(ledger, "old-but-used", H("c"), 0);
    ledger.executions.set("e1", { executionId: "e1", bundle: H("c") } as never);
    const { events, report } = reconcileSeed(
      ledger,
      [shipped("wordcount", H("e")), shipped("mandelbrot", H("d"))],
      { defaultProgram: "mandelbrot", now: NOW },
    );
    expect(events.map((e) => e.kind)).toEqual(["programAdded", "programAdded", "setDefaultLoop"]);
    expect(report.stale).toEqual([]);
    expect(report.defaultLoop).toBe("mandelbrot");
    expect(events.at(-1)).toEqual({
      kind: "setDefaultLoop",
      loop: { bundle: H("d"), params: { preset: 0 } },
    });
  });
});
