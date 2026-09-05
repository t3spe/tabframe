// `mise run goldens`: run a program single-threaded under Node, hash every task output, and write
// programs/<name>/goldens.json. The churn simulation and the Playwright tests compare against
// these. Also the timing tool for pacing: `--preset N` times one preset, `--all` times every one.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Bar, decodeBars, programManifest } from "@tabframe/protocol";
import { instantiate, loadProgram, runStaged } from "./host.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? "") : null;
};
const programName = flag("--program") ?? "mandelbrot";
const dir = path.join(root, "programs", programName);
const wasm = new Uint8Array(readFileSync(path.join(dir, "dist", "program.wasm")));
const manifest = programManifest.parse(
  JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")),
);

export interface GoldenRun {
  params: Record<string, unknown>;
  stageName: string;
  taskCount: number;
  hashes: string[];
  msPerTile: { min: number; median: number; p95: number; max: number; total: number };
}

export async function runGolden(
  params: Record<string, unknown>,
  sample?: number,
): Promise<GoldenRun> {
  const { module } = loadProgram(wasm);
  const planner = instantiate(module);
  const spec = planner.plan(0, params, { nodes: 1 });
  if (spec.kind !== "stage") throw new Error("stage 0 must be a stage");
  const times: number[] = [];
  const hashes: string[] = [];
  const count = spec.tasks.length;
  const step = sample ? Math.max(1, Math.floor(count / sample)) : 1;
  for (let i = 0; i < count; i += step) {
    const task = spec.tasks[i] as (typeof spec.tasks)[number];
    const inst = instantiate(module);
    // CPU time, not wall time: the pacing numbers must not depend on what else the machine is
    // doing while goldens are regenerated (WP4.3).
    const c0 = process.cpuUsage();
    const out = inst.run(0, i, count, task.input);
    const c1 = process.cpuUsage(c0);
    times.push((c1.user + c1.system) / 1000);
    hashes.push(createHash("sha256").update(out).digest("hex"));
  }
  const sorted = [...times].sort((a, b) => a - b);
  const total = times.reduce((a, b) => a + b, 0) * step;
  return {
    params,
    stageName: spec.name,
    taskCount: count,
    hashes,
    msPerTile: {
      min: round(sorted[0] ?? 0),
      median: round(sorted[Math.floor(sorted.length / 2)] ?? 0),
      p95: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0),
      max: round(sorted[sorted.length - 1] ?? 0),
      total: round(total),
    },
  };
}

const round = (n: number) => Math.round(n * 10) / 10;

/** A program's bundle inputs: programs/<name>/in/<file> → /in/<file>. */
export function inputsOf(programDir: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const inDir = path.join(programDir, "in");
  if (!existsSync(inDir)) return files;
  for (const f of readdirSync(inDir).sort())
    files.set(`/in/${f}`, new Uint8Array(readFileSync(path.join(inDir, f))));
  return files;
}

/** Goldens for a staged program (`bars`/`text` views): every stage's output hashes and the decoded result. */
export interface StagedGolden {
  params: Record<string, unknown>;
  stages: Array<{ name: string; taskCount: number; hashes: string[] }>;
  final: { hash: string; bars: Bar[] | null } | null;
  followUp: Record<string, unknown> | null;
  msTotal: number;
}

export async function runStagedGolden(
  params: Record<string, unknown>,
  inputs: Map<string, Uint8Array>,
): Promise<StagedGolden> {
  const { module } = loadProgram(wasm);
  const t0 = performance.now();
  const r = runStaged(module, inputs, params);
  const final = r.final
    ? {
        hash: createHash("sha256").update(r.final).digest("hex"),
        bars: manifest.view === "bars" ? decodeBars(r.final) : null,
      }
    : null;
  return {
    params,
    stages: r.stages.map((s) => ({ name: s.name, taskCount: s.taskCount, hashes: s.hashes })),
    final,
    followUp: r.followUp,
    msTotal: round(performance.now() - t0),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const preset = flag("--preset");
  const sample = flag("--sample");
  if (args.includes("--all")) {
    for (let p = 0; ; p++) {
      const r = await runGolden(
        { ...manifest.defaultParams, preset: p },
        sample ? Number(sample) : 8,
      );
      console.log(
        `preset ${p}: ${r.taskCount} tiles, cpu ms/tile min ${r.msPerTile.min} median ${r.msPerTile.median} p95 ${r.msPerTile.p95} max ${r.msPerTile.max}, est. frame ${Math.round(r.msPerTile.total / 1000)} s`,
      );
      const next = instantiate(loadProgram(wasm).module).plan(1, {
        ...manifest.defaultParams,
        preset: p,
      });
      if (next.kind !== "done" || !next.next || Number(next.next.preset) === 0) break;
    }
  } else if (preset !== null) {
    const r = await runGolden(
      { ...manifest.defaultParams, preset: Number(preset) },
      sample ? Number(sample) : undefined,
    );
    console.log(JSON.stringify({ preset: Number(preset), ...r.msPerTile, taskCount: r.taskCount }));
  } else if (manifest.view !== "tiles") {
    // Staged programs: the whole execution single-threaded, every stage's hashes, the final bars.
    const r = await runStagedGolden(manifest.defaultParams, inputsOf(dir));
    const file = path.join(dir, "goldens.json");
    // One-hash arrays on one line, the way the repository's formatter prints them.
    const json = JSON.stringify(r, null, 2).replace(/\[\n\s+("[0-9a-f]{64}")\n\s+\]/g, "[$1]");
    writeFileSync(file, `${json}\n`);
    console.log(
      `[goldens] ${programName}: ${r.stages.map((s) => `${s.name} ${s.taskCount}`).join(", ")}; ${r.msTotal} ms → ${path.relative(root, file)}`,
    );
    if (r.final?.bars) {
      for (const { label, value } of r.final.bars.slice(0, 10)) console.log(`  ${label}: ${value}`);
    }
  } else {
    const r = await runGolden(manifest.defaultParams);
    const file = path.join(dir, "goldens.json");
    writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
    console.log(
      `[goldens] ${programName}: ${r.taskCount} tasks, ms/tile min ${r.msPerTile.min} median ${r.msPerTile.median} max ${r.msPerTile.max}, frame ${Math.round(r.msPerTile.total / 1000)} s → ${path.relative(root, file)}`,
    );
  }
}
