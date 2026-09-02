import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUNDLE_PATHS, fsManifest } from "@tabframe/protocol";
import { LocalStore } from "@tabframe/store";
import { buildFixturePrograms, PROGRAMS_DIR } from "./fixtures.ts";
import { discoverPrograms, seedPrograms } from "./seed.ts";

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
});
