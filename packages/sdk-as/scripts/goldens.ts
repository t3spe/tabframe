// `mise run goldens`: run a program single-threaded under Node, hash every task output, and write
// programs/<name>/goldens.json. The churn simulation and the Playwright tests compare against
// these. Also the timing tool for pacing: `--preset N` times one preset, `--all` times every one.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { programManifest } from "@tabframe/protocol";
import { instantiate, loadProgram } from "./host.ts";

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
  msPerTile: { min: number; median: number; max: number; total: number };
}

export async function runGolden(
  params: Record<string, unknown>,
  sample?: number,
): Promise<GoldenRun> {
  const { module } = await loadProgram(wasm);
  const planner = await instantiate(module);
  const spec = planner.plan(0, params, { nodes: 1 });
  if (spec.kind !== "stage") throw new Error("stage 0 must be a stage");
  const times: number[] = [];
  const hashes: string[] = [];
  const count = spec.tasks.length;
  const step = sample ? Math.max(1, Math.floor(count / sample)) : 1;
  for (let i = 0; i < count; i += step) {
    const task = spec.tasks[i] as (typeof spec.tasks)[number];
    const inst = await instantiate(module);
    const t0 = performance.now();
    const out = inst.run(0, i, count, task.input);
    times.push(performance.now() - t0);
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
      max: round(sorted[sorted.length - 1] ?? 0),
      total: round(total),
    },
  };
}

const round = (n: number) => Math.round(n * 10) / 10;

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
        `preset ${p}: ${r.taskCount} tiles, ms/tile min ${r.msPerTile.min} median ${r.msPerTile.median} max ${r.msPerTile.max}, est. frame ${Math.round(r.msPerTile.total / 1000)} s`,
      );
      const next = (await instantiate((await loadProgram(wasm)).module)).plan(1, {
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
  } else {
    const r = await runGolden(manifest.defaultParams);
    const file = path.join(dir, "goldens.json");
    writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
    console.log(
      `[goldens] ${programName}: ${r.taskCount} tasks, ms/tile min ${r.msPerTile.min} median ${r.msPerTile.median} max ${r.msPerTile.max}, frame ${Math.round(r.msPerTile.total / 1000)} s → ${path.relative(root, file)}`,
    );
  }
}
