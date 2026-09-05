// `mise run goldens`: run a program single-threaded under Node, hash every task output, and write
// programs/<name>/goldens.json; with `--check`, compare the hashes to the committed file instead.
// The churn simulation, the control-plane fixtures, and the browser suites read these files. Also
// the pacing tool: `--preset N` times one Mandelbrot preset, `--all` times every one.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Bar, canonicalStringify, decodeBars, type ProgramManifest } from "@tabframe/protocol";
import { instantiate, loadProgram, runStaged, sha256Hex } from "./host.ts";
import { distModule, inputsOf, programDir, ROOT, readGoldens, readManifest } from "./programs.ts";

/** Goldens for a tiles program: stage 0's task hashes and the CPU time per tile. */
export interface GoldenRun {
  params: Record<string, unknown>;
  stageName: string;
  taskCount: number;
  hashes: string[];
  msPerTile: { min: number; median: number; p95: number; max: number; total: number };
}

export function runGolden(
  module: WebAssembly.Module,
  params: Record<string, unknown>,
  sample?: number,
): GoldenRun {
  const spec = instantiate(module).plan(0, params, { nodes: 1 });
  if (spec.kind !== "stage") throw new Error("stage 0 must be a stage");
  const times: number[] = [];
  const hashes: string[] = [];
  const count = spec.tasks.length;
  const step = sample ? Math.max(1, Math.floor(count / sample)) : 1;
  for (let i = 0; i < count; i += step) {
    const task = spec.tasks[i] as (typeof spec.tasks)[number];
    const inst = instantiate(module);
    // CPU time, not wall time: the pacing numbers must not depend on what else the machine is doing.
    const c0 = process.cpuUsage();
    const out = inst.run(0, i, count, task.input);
    const c1 = process.cpuUsage(c0);
    times.push((c1.user + c1.system) / 1000);
    hashes.push(sha256Hex(out));
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

/** Goldens for a staged program (`bars`/`text`): every stage's hashes and the decoded final payload. */
export interface StagedGolden {
  params: Record<string, unknown>;
  stages: Array<{ name: string; taskCount: number; hashes: string[] }>;
  final: { hash: string; bars: Bar[] | null } | null;
  followUp: Record<string, unknown> | null;
  msTotal: number;
}

export function runStagedGolden(
  module: WebAssembly.Module,
  manifest: ProgramManifest,
  params: Record<string, unknown>,
  inputs: Map<string, Uint8Array>,
): StagedGolden {
  const t0 = performance.now();
  const r = runStaged(module, inputs, params);
  const final = r.final
    ? { hash: sha256Hex(r.final), bars: manifest.view === "bars" ? decodeBars(r.final) : null }
    : null;
  return {
    params,
    stages: r.stages.map((s) => ({ name: s.name, taskCount: s.taskCount, hashes: s.hashes })),
    final,
    followUp: r.followUp,
    msTotal: round(performance.now() - t0),
  };
}

/** A golden without its timings, canonical: what `--check` compares. */
export function stableGolden(golden: object): string {
  const rest: Record<string, unknown> = { ...golden };
  rest.msPerTile = undefined;
  rest.msTotal = undefined;
  return canonicalStringify(rest);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? (args[i + 1] ?? "") : null;
  };
  const programName = flag("--program") ?? "mandelbrot";
  const manifest = readManifest(programName);
  const { module } = loadProgram(distModule(programName));
  const file = path.join(programDir(programName), "goldens.json");
  const preset = flag("--preset");
  const sample = flag("--sample");
  if (args.includes("--all")) {
    for (let p = 0; ; p++) {
      const params = { ...manifest.defaultParams, preset: p };
      const r = runGolden(module, params, sample ? Number(sample) : 8);
      console.log(
        `preset ${p}: ${r.taskCount} tiles, cpu ms/tile min ${r.msPerTile.min} median ${r.msPerTile.median} p95 ${r.msPerTile.p95} max ${r.msPerTile.max}, est. frame ${Math.round(r.msPerTile.total / 1000)} s`,
      );
      const next = instantiate(module).plan(1, params);
      if (next.kind !== "done" || !next.next || Number(next.next.preset) === 0) break;
    }
  } else if (preset !== null) {
    const r = runGolden(
      module,
      { ...manifest.defaultParams, preset: Number(preset) },
      sample ? Number(sample) : undefined,
    );
    console.log(JSON.stringify({ preset: Number(preset), ...r.msPerTile, taskCount: r.taskCount }));
  } else {
    const golden =
      manifest.view === "tiles"
        ? runGolden(module, manifest.defaultParams)
        : runStagedGolden(module, manifest, manifest.defaultParams, inputsOf(programName));
    if (args.includes("--check")) {
      const same = stableGolden(readGoldens<object>(programName)) === stableGolden(golden);
      console.log(
        `[goldens] ${programName}: hashes ${same ? "match" : "DIFFER from"} ${path.relative(ROOT, file)}`,
      );
      if (!same) process.exit(1);
    } else {
      // One-hash arrays on one line, the way the repository's formatter prints them.
      const json = JSON.stringify(golden, null, 2).replace(
        /\[\n\s+("[0-9a-f]{64}")\n\s+\]/g,
        "[$1]",
      );
      writeFileSync(file, `${json}\n`);
      if ("stages" in golden) {
        console.log(
          `[goldens] ${programName}: ${golden.stages.map((s) => `${s.name} ${s.taskCount}`).join(", ")}; ${golden.msTotal} ms → ${path.relative(ROOT, file)}`,
        );
        for (const { label, value } of golden.final?.bars?.slice(0, 10) ?? []) {
          console.log(`  ${label}: ${value}`);
        }
      } else {
        console.log(
          `[goldens] ${programName}: ${golden.taskCount} tasks, ms/tile min ${golden.msPerTile.min} median ${golden.msPerTile.median} max ${golden.msPerTile.max}, frame ${Math.round(golden.msPerTile.total / 1000)} s → ${path.relative(ROOT, file)}`,
        );
      }
    }
  }
}
