// `mise run sim`: the churn simulation from the command line.
//
//   node packages/core/sim/run.ts [--seed N | --seeds A..B] [--long] [--tiles N] [--frames N]
//                                 [--liar | --honest] [--drill] [--verbose] [--keep-going]
//
// Default: seeds 1..3 of the normal scenario over whole frames. `--long` runs the long scenario
// over seeds 1..1000 (the WP1.9 acceptance). `--tiles N` keeps only the N outermost tiles of each
// frame, which is what the test suite uses. Exit status 1 names the first failing seed.
import { computeCacheStats } from "./program.ts";
import { runSim, type SimReport } from "./sim.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? "") : null;
};
const has = (name: string): boolean => args.includes(name);

const long = has("--long");
const seeds = parseSeeds(flag("--seeds") ?? flag("--seed"), long);
const tilesFlag = flag("--tiles");
const tiles = tilesFlag === null ? null : Number(tilesFlag);
const liar = has("--liar") ? true : has("--honest") ? false : null;
const verbose = has("--verbose");
const keepGoing = has("--keep-going");
const drill = has("--drill");
const framesFlag = flag("--frames");
const frames = framesFlag === null ? undefined : Number(framesFlag);

function parseSeeds(text: string | null, longMode: boolean): number[] {
  if (text === null) return longMode ? range(1, 1000) : range(1, 3);
  const m = /^(\d+)(?:\.\.|-)(\d+)$/.exec(text);
  if (m) return range(Number(m[1]), Number(m[2]));
  const n = Number(text);
  if (!Number.isInteger(n)) throw new Error(`bad seed ${text}`);
  return [n];
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

export function formatReport(r: SimReport): string {
  const s = r.stats;
  const closes = Object.entries(s.closes)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  const lies = r.scenario.liars > 0 ? `  lies ${s.liesTold} told, ${s.liesAccepted} accepted` : "";
  const fleet = `cores ${s.coresLaunched} launched, ${s.coresKilled} killed, ${s.coresTerminated} terminated${s.coresAdriftMs > 0 ? `, adrift up to ${(s.coresAdriftMs / 1000).toFixed(1)} s` : ""}${s.sleeps > 0 ? `, ${s.sleeps} sleeps/${s.wakes} wakes` : ""}`;
  return [
    `seed ${r.seed}`.padEnd(10),
    r.ok ? "ok  " : "FAIL",
    `frames ${s.framesDone} done, ${s.framesCancelled} cancelled, ${s.framesFailed} failed`,
    `nodes ${s.joins} joins (peak ${s.peakNodes}), ${s.leaves} leaves, ${s.crashes} crashes, ${s.freezes} freezes`,
    `tasks ${s.assigned} attempts, ${s.done} done, ${s.reassigned} reassigned, ${s.speculated} speculated, ${s.verified} verified, ${s.mismatched} mismatched`,
    fleet,
    `closes ${closes || "none"}${lies}`,
    `virtual ${(r.virtualMs / 60_000).toFixed(1)} min, wall ${(r.wallMs / 1000).toFixed(1)} s`,
  ].join("  ");
}

const started = performance.now();
let failed: SimReport | null = null;
let passed = 0;
for (const seed of seeds) {
  const report = runSim({
    seed,
    long,
    tiles,
    verbose,
    liar,
    keepGoing,
    drill,
    ...(frames === undefined ? {} : { frames }),
  });
  console.log(formatReport(report));
  if (!report.ok) {
    failed = report;
    break;
  }
  passed += 1;
}
const cache = computeCacheStats();
const wall = ((performance.now() - started) / 1000).toFixed(1);
if (failed) {
  console.log(
    `\nseed ${failed.seed} violated ${failed.violations.length} propert${failed.violations.length === 1 ? "y" : "ies"}:`,
  );
  for (const v of failed.violations.slice(0, 40)) console.log(`  ${v}`);
  if (failed.violations.length > 40) console.log(`  … ${failed.violations.length - 40} more`);
  console.log(
    `\nreplay: node packages/core/sim/run.ts --seed ${failed.seed}${long ? " --long" : ""}${tiles !== null ? ` --tiles ${tiles}` : ""}${liar === true ? " --liar" : liar === false ? " --honest" : ""} --verbose`,
  );
  process.exit(1);
}
console.log(
  `\n${passed} seed${passed === 1 ? "" : "s"} passed in ${wall} s (${cache.misses} real task computations, ${cache.entries} cached)`,
);
