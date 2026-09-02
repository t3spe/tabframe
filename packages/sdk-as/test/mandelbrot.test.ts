import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { programManifest } from "@tabframe/protocol";
import { compileProgram } from "../scripts/build-programs.ts";
import { instantiate, loadProgram, memoryLimits, type ProgramInstance } from "../scripts/host.ts";

const root = path.resolve(import.meta.dir, "../../..");
const programDir = path.join(root, "programs", "mandelbrot");
const out = path.join(import.meta.dir, "..", "dist-test", "mandelbrot.wasm");
let module: WebAssembly.Module;
let wasm: Uint8Array;
let planner: ProgramInstance;
const manifest = programManifest.parse(
  JSON.parse(readFileSync(path.join(programDir, "manifest.json"), "utf8")),
);
const params = manifest.defaultParams;

beforeAll(async () => {
  await compileProgram(path.join(programDir, "assembly", "index.ts"), out);
  wasm = new Uint8Array(readFileSync(out));
  module = (await loadProgram(wasm)).module;
  planner = await instantiate(module);
}, 60_000);

describe("module", () => {
  test("only env.abort is imported, the four exports exist, memory maximum is declared, under 32 KB", async () => {
    const { imports, exports } = await loadProgram(wasm);
    expect(imports).toEqual(["env.abort"]);
    expect(exports.sort()).toEqual(["alloc", "memory", "plan", "run"]);
    expect(memoryLimits(wasm).max).toBe(256);
    expect(wasm.length).toBeLessThan(32 * 1024);
  });
  test("manifest is valid and names the tiles view", () => {
    expect(manifest.name).toBe("mandelbrot");
    expect(manifest.view).toBe("tiles");
    expect(params).toEqual({ preset: 0, palette: "ocean" });
  });
});

describe("plan", () => {
  test("stage 0: 640 placed tiles covering a 2048×1280 canvas exactly once, centre-out", () => {
    const spec = planner.plan(0, params, { nodes: 3 });
    expect(spec.kind).toBe("stage");
    if (spec.kind !== "stage") return;
    expect(spec.name).toBe("render");
    expect(spec.canvas).toEqual({ w: 2048, h: 1280 });
    expect(spec.tasks.length).toBe(640);
    const seen = new Set<string>();
    let last = -1;
    for (const t of spec.tasks) {
      expect(t.place).toBeDefined();
      const p = t.place as { x: number; y: number; w: number; h: number };
      expect(p.w).toBe(64);
      expect(p.h).toBe(64);
      expect(p.x % 64).toBe(0);
      expect(p.y % 64).toBe(0);
      seen.add(`${p.x},${p.y}`);
      const d = (p.x + 32 - 1024) ** 2 + (p.y + 32 - 640) ** 2;
      expect(d).toBeGreaterThanOrEqual(last);
      last = d;
      expect(t.input.length).toBe(8 * 3 + 4 * 3 + 2 + 4 * 4);
    }
    expect(seen.size).toBe(640);
    const first = spec.tasks[0]?.place as { x: number; y: number };
    expect(Math.abs(first.x + 32 - 1024)).toBeLessThanOrEqual(32);
    expect(Math.abs(first.y + 32 - 640)).toBeLessThanOrEqual(32);
  });
  test("stage 1: done with the next preset and the same palette; presets wrap around", () => {
    const next = planner.plan(1, params);
    expect(next).toEqual({ kind: "done", next: { preset: 1, palette: "ocean" } });
    const wrap = planner.plan(1, { preset: 7, palette: "fire" });
    expect(wrap).toEqual({ kind: "done", next: { preset: 0, palette: "fire" } });
    const unknownPalette = planner.plan(1, { preset: 2, palette: "nope" });
    expect(unknownPalette).toEqual({ kind: "done", next: { preset: 3, palette: "ocean" } });
  });
  test("every preset plans 640 tiles", () => {
    for (let preset = 0; preset < 8; preset++) {
      const spec = planner.plan(0, { preset, palette: "mono" });
      expect(spec.kind === "stage" && spec.tasks.length).toBe(640);
    }
  });
});

describe("run", () => {
  const goldens = JSON.parse(readFileSync(path.join(programDir, "goldens.json"), "utf8")) as {
    hashes: string[];
    taskCount: number;
  };
  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

  test("a tile is 64×64 RGBA with alpha 255 and both interior and exterior pixels; two runs are identical", async () => {
    const spec = planner.plan(0, params);
    if (spec.kind !== "stage") throw new Error("stage expected");
    const centre = spec.tasks[0] as (typeof spec.tasks)[number];
    const a = (await instantiate(module)).run(0, 0, 640, centre.input);
    const b = (await instantiate(module)).run(0, 0, 640, centre.input);
    expect(a.length).toBe(64 * 64 * 4);
    expect(a).toEqual(b);
    let black = 0;
    let colored = 0;
    for (let i = 0; i < a.length; i += 4) {
      expect(a[i + 3]).toBe(255);
      if (a[i] === 0 && a[i + 1] === 0 && a[i + 2] === 0) black++;
      else colored++;
    }
    // The overview's centre tile straddles the main cardioid's edge.
    expect(black).toBeGreaterThan(0);
    expect(colored).toBeGreaterThan(0);
  });
  test("palette changes the bytes, and mono tiles are grey", async () => {
    const fire = planner.plan(0, { preset: 0, palette: "fire" });
    const mono = planner.plan(0, { preset: 0, palette: "mono" });
    const ocean = planner.plan(0, params);
    if (fire.kind !== "stage" || mono.kind !== "stage" || ocean.kind !== "stage")
      throw new Error("stage expected");
    const i = 200;
    const fireTile = (await instantiate(module)).run(
      0,
      i,
      640,
      (fire.tasks[i] as (typeof fire.tasks)[number]).input,
    );
    const monoTile = (await instantiate(module)).run(
      0,
      i,
      640,
      (mono.tasks[i] as (typeof mono.tasks)[number]).input,
    );
    const oceanTile = (await instantiate(module)).run(
      0,
      i,
      640,
      (ocean.tasks[i] as (typeof ocean.tasks)[number]).input,
    );
    expect(fireTile).not.toEqual(oceanTile);
    for (let p = 0; p < monoTile.length; p += 4) {
      expect(monoTile[p]).toBe(monoTile[p + 1] as number);
      expect(monoTile[p]).toBe(monoTile[p + 2] as number);
    }
  });
  test("a deterministic sample of tiles matches goldens.json", async () => {
    expect(goldens.taskCount).toBe(640);
    expect(goldens.hashes.length).toBe(640);
    const spec = planner.plan(0, params);
    if (spec.kind !== "stage") throw new Error("stage expected");
    for (let i = 0; i < 640; i += 40) {
      const task = spec.tasks[i] as (typeof spec.tasks)[number];
      const tile = (await instantiate(module)).run(0, i, 640, task.input);
      expect(sha(tile)).toBe(goldens.hashes[i] as string);
    }
  }, 60_000);
});
