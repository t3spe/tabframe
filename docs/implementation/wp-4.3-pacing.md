# WP4.3 — Performance and pacing

**Milestone:** M4 · **Branch:** `wp/4.3-pacing` · **Merged:** 2026-09-02 · **Packages:**
`programs/mandelbrot`, `packages/sdk-as` (the goldens tool), `packages/core` (pruning)

## What

Four measurements and the changes they asked for: the Mandelbrot frame's tile timing, word count's
three stages, the ledger snapshot's size, and — left for the parent — the MicroVM's resume latency.

### The frame: 106 s → 22 s, and no tile above a third of a second

Before this work the default frame cost **106 s of single-node compute** with a median tile of
3.8 ms and a **worst tile of 1.3 s** — three hundred times the median. The worst tiles were the
interior of the set: every pixel iterating to `maxIter` for nothing. That distribution is what
the plan's "tile timing" item was about: the scheduler's deadline is three times the median with a
two-second floor, and in a browser tab, where tiles run two to four times slower than under Node, a
1.3 s tile becomes a 3–5 s one and is speculated on every time.

Two changes, in order:

1. **Exact interior shortcuts, output unchanged.** A point inside the main cardioid or the period-2
   bulb never escapes, and an orbit that returns *exactly* (f64 equality, Brent's doubling
   schedule) to an earlier point is periodic and never escapes either. Both answers are exact —
   pure f64 arithmetic, no tolerance — so the rendered bytes do not change: re-running the
   committed goldens with the shortcuts in place reproduced **all 640 hashes** while the frame
   dropped from 106 s to 4.3 s and the worst tile from 1323 ms to 141 ms. The 25× was free.
2. **Retuned presets, goldens regenerated.** With the interior nearly free, the frame was too fast
   and the remaining cost sat in boundary tiles and in the interior tiles the shortcuts cannot
   catch (orbits near the boundary that converge too slowly to repeat before `maxIter`). Those
   cost `ss² × 4096 × maxIter` iterations whatever the zoom, so each preset now keeps the product
   `ss² × maxIter` at or under about 7 000 — a worst-case tile of about half a second under Node,
   about two seconds in a tab — and gets its quality from supersampling where the geometry is
   cheap and from `maxIter` where it is not. Preset 0 is the default frame and pins the goldens;
   they were regenerated in the same commit.

Every tile of every preset, measured in CPU time under Node (the goldens tool now reports CPU
time rather than wall time, because the machine was busy while this was measured, and a p95):

| Preset | Before (wall, sampled): frame / max tile | After (CPU, every tile): frame / median / p95 / max |
|---|---|---|
| 0 overview | 106 s / 1323 ms | **21.9 s** / 33 / 63 / 162 ms |
| 1 seahorse valley | 68 s / 318 ms | 28 s / 36 / 96 / 172 ms |
| 2 elephant valley | 37 s / 159 ms | 10 s / 6 / 74 / 218 ms |
| 3 triple spiral | 76 s / 2347 ms | 18 s / 18 / 79 / 150 ms |
| 4 antenna minibrot | 49 s / 109 ms | 26 s / 32 / 98 / 160 ms |
| 5 double spiral | 50 s / 214 ms | 24 s / 29 / 88 / 208 ms |
| 6 feigenbaum | 73 s / 1224 ms | 43 s / 24 / 222 / 303 ms |
| 7 julia island | 91 s / 346 ms | 54 s / 79 / 143 / 201 ms |

The "before" column is sampled (every eighth tile) and undercounts the worst tiles: the full run of
preset 0 said 106 s and 1323 ms where the sample said 34 s and 1152 ms. The "after" column is every
tile. The worst tile across all eight presets is now 303 ms, against 2347 ms before.

On "about a minute per frame single-node": the plan's node is a browser tab, and a tab runs these
tiles two to four times slower than Node (WP2.6 measured 0.3 s per tile in Chromium against 0.17 s
under Node for the old program), so 22–54 s of Node compute is roughly a minute per frame in one
tab. Pushing the Node number itself to 60 s would mean either a worst tile past the deadline floor
in a browser or a 12× supersample of the overview, and neither is worth having.

### Word count: nothing to batch

Single-node, CPU time, over Moby-Dick (1.2 MB):

| Stage | Tasks | Total | Per task min / median / max | Reads |
|---|---|---|---|---|
| map | 32 | 156 ms | 3.1 / 3.8 / 16.9 ms | the corpus range |
| reduce | 8 | 32 ms | 3.2 / 3.9 / 4.8 ms | 32 map outputs, 0.92 MB in all |
| merge | 1 | 9.5 ms | — | 8 reduce outputs, 268 KB |

The whole program is about 200 ms of compute. Each reduce task reads all 32 map outputs and that
costs it four milliseconds; on the cluster the stage is paced by assignment round trips and blob
fetches, not by reading. The plan's "batch reads if reduce is slow" does not apply; the numbers
say leave it.

### Snapshot size: the tasks had to go

Measured with the core's test harness at the machine's working size — one execution with 640
tasks in flight plus `KEEP_ENDED_EXECUTIONS` (32) finished frames of 640 tiles each — and
confirmed on the deployed machine by the parent from `/health`:

| | Executions | Tasks | Plain | Gzipped |
|---|---|---|---|---|
| Before, synthetic (hashes repeat, so gzip flatters it) | 33 | 21 185 | 22.4 MB | 586 KB |
| Before, deployed (real hashes) | 32 ended | 18 705 | — | **2.16 MB** |
| After, synthetic | 33 | 1 925 | 3.9 MB | 195 KB |

Two megabytes gzipped, serialized and pushed to S3 every five seconds while the ledger changes, on
a half-vCPU control plane, is not comfortable. The records were never the problem — an execution
record is a few hundred bytes — the tasks were: a frame's 640 task records with their attempts and
results are hundreds of kilobytes, and 32 frames of them is the whole snapshot. `pruneExecutions`
now keeps the *records* of the last 32 ended executions (so the queue, the activity, and follow-ups
still work) but the *tasks* of only the last `KEEP_ENDED_TASKS = 2`, so the two most recent frames
stay browsable in the task detail and files panels and older ones keep their record alone. The
running execution is never touched. The scan runs only when an ended execution beyond the two
still has tasks, so ticks after the prune cost nothing. Expected on the deployed machine: about a
tenth of the size, roughly 200 KB gzipped per write.

### Resume latency

_To be measured by the parent on AWS (a suspended control plane's first request after the idle
policy fires; M0 measured resume under a second at 1 GB)._

## Tests

- `packages/core/src/loop.test.ts` gains "pruning ended executions' tasks": after five finished
  frames only the two most recent keep their tasks, all five keep their records with their stage
  task ids, the running execution is untouched, the invariants hold, and a second pass is a no-op.
- The Mandelbrot goldens are regenerated for the retuned default preset and every suite that
  reads them (the SDK tests, the churn simulation, the money shot, the runbooks) passes against
  the new file. The interior shortcuts were checked for exactness against the *old* goldens
  before the presets changed: 640 of 640 identical.

## Why this shape

- Exactness over tolerance: a periodicity check with an epsilon would be faster still but could
  colour an escaping point black; exact f64 equality cannot, and it is deterministic across engines
  because WebAssembly's f64 is.
- The `ss² × maxIter` rule is written into the program next to the presets, so the next person who
  wants a deeper zoom knows what a heavier preset costs and where the ceiling is.
- Pruning tasks rather than records keeps what the dashboard shows people (the history) and drops
  what only the scheduler needed (the attempts of frames that are over).

## Drift

- Presets retuned; `programs/mandelbrot/goldens.json` regenerated; the goldens' `msPerTile` is now
  CPU time and carries a p95.
- `KEEP_ENDED_TASKS = 2` alongside `KEEP_ENDED_EXECUTIONS = 32`.

## Left for the parent

- Resume latency on AWS.
- The deployed snapshot size after this lands, for the record.
