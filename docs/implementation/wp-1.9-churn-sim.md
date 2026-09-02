# WP1.9 — Churn simulation

**Milestone:** M1 · **Branch:** `wp/1.9-churn-sim` · **Package:** `packages/core/sim` (plus fixes in
`packages/core/src`)

## What

A discrete-event simulation of the whole machine around the pure core (design §12, plan WP1.9):
the control plane's `apply` driven on a virtual timeline by virtual nodes and observers, with a
fake content-addressed store, the real Mandelbrot program running through the real sandbox, a
seeded chaos generator, the invariants of §6.10 and a set of scheduling properties checked after
every event, and the goldens compared at the end of every frame. A run is a pure function of its
seed, so a violation is replayable to the event.

- `sim.ts` — the world: the process layer around the core (effects executed over sockets with
  latency, `fetchBlob`/`putBlob`/`presign` answered against the store, a 500 ms tick), the
  property checks, execution tracking, the goldens check, statistics, and the trace hash.
- `node.ts` — a virtual node: hello, heartbeat, `presign` → upload → `result`, cancel, the four
  commands; real task bytes through `runTask` against the store; virtual compute time drawn from
  the seed. Modes: clean leave, silent crash, freeze (no heartbeat, no compute), hidden tab (4×
  slower, heartbeats say so), slow hardware, throttle (10×), reconnect after a control-plane
  close, and a consistent liar.
- `observer.ts` — a virtual dashboard: subscribe, ping, controls; validates every message
  against the wire schema, page 0 of a snapshot, consecutive sequence numbers, and that a stage it
  watched from the start reports every task done before `stageDone`.
- `chaos.ts` — the seeded generator: join, leave, crash, freeze, thaw, hide, show, rejoin,
  observers coming and going, and the controls (`killHalf`, `freezeHalf`, `throttleHalf`,
  `resumeAll`, `restart`, `skip`, `launch`, `killExecution`, `runFollowUp`, `setRedundancy`),
  weighted and paced (one control a second and one launch a minute per observer, one
  frame-ending control per observer per 45 s so frames can finish). Two phases: chaos until enough
  frames completed and a minimum virtual duration passed (or a cap), then calm: liars retired,
  everyone thawed, at least two honest nodes and one observer, and the machine must finish a frame
  within a bounded time.
- `clock.ts` (a timer heap), `store.ts` (SHA-256 content-addressed bytes, the sandbox's
  `BlobReader`), `program.ts` (loads and validates `programs/mandelbrot/dist/program.wasm`, seeds
  it as a bundle, memoizes task computations per process), `types.ts`.
- `run.ts` — `mise run sim`: `--seed N | --seeds A..B`, `--long`, `--tiles N`, `--frames N`,
  `--liar | --honest`, `--verbose`, `--keep-going`. Default: seeds 1..3 of the normal scenario over
  whole frames; `--long` runs seeds 1..1000 of the long scenario. Exit 1 names the first failing
  seed, lists its violations, and prints the replay command.
- `sim.test.ts` — the suite runs honest seeds, a determinism check (same seed, same trace), the
  lying-node scenario with the toggle on and off, and a long-scenario seed, all on a 32-tile
  subset so the file finishes in seconds.

## How

- **Time and transport.** Everything is a timer on the virtual timeline (ties by creation order).
  Each socket has one FIFO per direction; a message arrives after 5–80 ms, a store round trip
  after 10–60 ms. A clean close is a `disconnected` event that arrives after the messages before
  it; a crash sends nothing more and is found through silence; a control-plane close reaches the
  client after the latency, so each side can be wrong about the other for a while, which is where
  the late results, stale cancels, and results from cancelled attempts come from.
- **Compute.** The bytes are real: a node frames the inline input with the ABI, resolves
  `fsRoot` to a manifest in the store, and calls `runTask` on the validated module with a caching
  reader. The *time* is virtual: each task's base cost is drawn once from the seed with the shape
  of the measured preset-0 tiles (72 % under 10 ms, 15 % between 0.3 and 1.3 s), multiplied by the
  node's speed, throttle, and visibility. Results carry that virtual `computeMs`, so deadlines,
  medians, and health labels behave as they would, and a run replays identically on any machine.
  A liar flips one byte of its run outputs on three quarters of inputs, always the same byte for
  the same input and node, so lies are consistent and two liars disagree with each other.
- **Store fidelity.** A node presigns the hashes it has not uploaded yet, uploads on the reply,
  then reports; the store hashes what it receives, so a reported hash is one the store vouches for
  (D18). The plan output is fetched from the store by the process layer, which may trim it
  (`--tiles N` keeps the N outermost tiles, the cheapest, mapping their indexes back to the
  goldens) and pins a `done` follow-up to the frame's own params, so every frame of the default loop
  is one the goldens cover and the compute cache already holds.
- **Checks after every event.** `checkInvariants` (§6.10 as code); an accepted result changes
  only through a mismatch; no node holds more than two tasks, none of them of an execution that is
  not running; after a tick nothing silent beyond the gone window survives; an `assign` goes to
  the socket of the node its attempt names, of the running execution, in tier order (fresh work
  never goes out while released work this node could take waits; a speculative twin only after
  the first attempt's deadline); every send goes to a connection the ledger still has; a painted
  tile is golden unless a liar painted it. Clients add their own: schema decoding, the frozen node
  never assigned, no third task, no fatal close codes (invalid, rate limited, version, generation),
  observer sequence numbers, snapshot pages, stage completeness.
- **At the end of a frame.** Every stage-0 task done, its accepted output equal to the golden (a
  lie is tolerated only where the design tolerates it: with the toggle off, or under the toggle
  when two node ids reported it or a vote by node ids favoured it, D7), 16 KiB in size, present in
  the store, and in the execution's files; the root manifest
  in the store equals the ledger's files. In the calm phase a frame must complete within a window
  sized from the tile count; otherwise the run is reported as stalled.
- **Determinism.** No real clock or random source anywhere; the core takes the seeded rng through
  the harness (which gained an optional random source). The trace hash covers every event and its
  effects; the test asserts two runs of one seed hash the same and a different seed does not.

## Why

- **Real program, virtual time.** The sandbox and the program are the real ones, so the goldens
  check means something; measuring time would make every run different and the deadline logic
  untestable, so time is drawn from the seed instead.
- **The compute cache.** A preset-0 frame is about 79 s of single-threaded WebAssembly; twins,
  retries, contested rounds, later frames, and later seeds reuse the bytes, so 120 seeds of the
  normal scenario run in about a minute after the first frame, and the same holds for whole
  frames (at most two distinct filesystem roots occur, so the cache fills twice).
- **The tail subset.** The planner orders tiles centre-out, so the tail holds the cheapest tiles;
  32 of them cost under 0.1 s to compute once, which keeps the test suite fast while every path
  through the scheduler is still exercised.

## What the simulation found

Each item is a control-plane fix in this branch with a focused test in `packages/core/src`.

1. **Results and presigns tripped the message rate limit** (§8.4). A node reports two messages
   per task; on the measured tiles (median under 5 ms) that is far above twenty a second, so
   every fast node would have been closed for "rate exceeded". Both are answers to assignments,
   which `maxInFlight` already paces, so they no longer count against the bucket; hello,
   heartbeat, and observer traffic still do.
2. **A node could agree with itself.** With the toggle on, a task whose twin's node died could be
   assigned again to the node that had already answered, and its two identical reports settled
   the task with no second computation (seed 9 of the 64-tile run, task t266). `fillable` and
   `speculatable` now exclude a node that reported this round, and a repeat report from the same
   node in the same round adds nothing.
3. **The vote's effects were dropped.** On the late-duplicate path the effects array was spread
   before the vote ran, so the `taskDone` and the cancels of a vote resolved by a late mismatch
   never left the core; observers saw a sequence gap (seed 56, `1304 → 1306`).
4. **A late mismatch after the fold retracted a committed result.** The retracted task was
   recomputed while the manifest that already held its output advanced the stage, and the
   execution finished with two nodes still holding it (long seed 23, execution e33). A stage is
   now sealed when it is folded (and a plan task once its spec is consumed): a later mismatch is
   announced and counted, nothing is withdrawn. A stored manifest for a stage that already moved on
   is ignored, and finishing an execution cancels any stray attempt.
5. **Votes count nodes, not reports.** A persistent liar that reported the same bytes round after
   round outvoted two honest nodes; the majority is now over distinct node ids.
6. **Two more invariants** in `checkInvariants`: a node holds only work of the running execution,
   and an ended execution leaves nothing pending or assigned.
7. **Snapshot pages overflowed the message cap.** A done tile's row is about 250 bytes, so a page
   of 256 rows of a whole frame is 64.5 KiB before the envelope, and `encode` refused it (long
   seed 1 over whole frames: `snapshot to c42: message is 67345 bytes`); a dashboard subscribing
   mid-frame would never have received that page. Pages are now packed by bytes as well as by row
   count, page 0 counting the cluster it carries (§8.3).
8. **A stale result closed the wrong attempt.** A result was matched to "the node's running
   attempt" rather than to the attempt it names, so a late report for an attempt the control
   plane had cancelled closed a newer attempt of the same task on the same node; the node kept
   computing work the control plane thought finished and was handed a third task (long seed
   845, `v39/n160 assigned t3055 with 2 already in flight`). A result now closes only its own
   attempt and still counts as evidence for the task.
9. **A tied vote went to whoever reported first.** After two contested rounds between one liar and
   one honest node the tally was one to one and the liar, being faster, was first in the list;
   its tile was painted two milliseconds before a third node's honest report arrived (long seed
   144, task t185). A tie is no longer a majority: the task goes round once more, up to a cap of
   four rounds. And "recompute from scratch" (D7) now means by nodes that have not reported on
   the task, whenever one has a free slot, so a fast liar cannot keep answering its own contest;
   with nobody fresh, anyone free takes it and a cluster of two still makes progress.

## Evidence

- `bun test packages/core`: 52 tests (45 core, 7 simulation), among them the new ones: solicited
  messages under the rate limit; the second attempt never goes to the node that answered; a node
  cannot agree with itself; the vote counts nodes; the vote's outcome reaches nodes and observers;
  a mismatch after the fold withdraws nothing; snapshot pages of a full frame of done tiles stay
  under the cap; a stale result closes no newer attempt; a contested task goes to a node that has
  not reported; a tie starts another round. Full workspace: {{WORKSPACE_TESTS}} tests
  pass; all three `tsc` projects clean; Biome clean.
- `node packages/core/sim/run.ts`: normal scenario, seeds 1–120 on 32- and 64-tile subsets, all
  pass (about a minute in total); long scenario, seeds 1–25 on the 64-tile subset (180 s);
  whole 640-tile frames, seeds 1–3 (239 s wall, 1 295 real task computations, 3 frames per seed).
- Long scenario, seeds 1–1000 on the 64-tile subset, and seeds 1–10 over whole frames: in
  progress at the time of this commit; the numbers land in the follow-up commit.
- A typical line: `seed 24 ok frames 48 done, 4 cancelled, 0 failed nodes 216 joins (peak 28), 34
  leaves, 54 crashes, 37 freezes tasks 5015 attempts, 3360 done, 44 reassigned, 155 speculated,
  6 verified, 0 mismatched closes declaredGone 109 lies 6 told, 5 accepted virtual 5.0 min, wall
  5.3 s`. The only close code any well-behaved client ever receives is `declaredGone`.
- Coverage: `packages/core/sim` is exercised by its tests but excluded from the gate (it is a
  tool, and its worker-like loops are measured through the core it drives); the core's own line
  coverage stays above 95 %.

## Dependencies introduced

None outside the workspace; `@tabframe/core` gains `@tabframe/sandbox` as a dev dependency so
the simulation can run tasks.

## Drift

Recorded in design §17 (2026-09-03, WP1.9):

- §8.4: the per-node rate limit applies to unsolicited messages; results and presigns are paced
  by assignment.
- §6.5, D7: agreement means two nodes. A repeat report from the same node in a round adds no
  evidence; the second attempt of a round never goes to a node that already reported; the vote
  after two contested rounds counts distinct nodes. With the toggle on, a task on a cluster of one
  waits for a second node (the §6.10 liveness invariant is stated for the default mode).
- §6.5, §6.6: once a stage is folded (or a plan spec consumed) its results are sealed; a later
  mismatch is announced and counted, not acted on.
- §6.10: two more invariants (above).
- §8.3: snapshot pages are bounded by bytes as well as by 256 rows; a subscriber may receive more
  pages than `tasks / 256`.
- §6.5: a result closes the attempt it names; a report for any other attempt of the task is
  evidence only.
- D7: a contested task is recomputed by nodes that have not reported on it when one has a free
  slot; after two contested rounds a strict majority of nodes settles it, a tie starts another
  round, and the fourth round's tie is broken by report order.

Simulation simplifications, stated so nobody mistakes them for the machine's behaviour: the
default loop's follow-up is pinned to the frame's own params (preset 0), `--tiles` trims the plan,
compute time is drawn rather than measured, a node commanded to freeze reconnects after the
control plane hangs up (the host restarts its worker), and a node crash drops its socket without
a close.

## Open

- The thousand-seed acceptance runs on the 64-tile subset; whole frames are covered by fewer
  seeds because the simulation's own bookkeeping over 640 tasks dominates the wall time. A
  nightly job (design §12) can run the whole-frame long mode.
- A liar that reconnects is a new node (D11): long seed 403 shows one reporting a tile, being
  closed by `killHalf`, rejoining, drawing the same task's second attempt, and agreeing with its
  former self. Agreement by host id would not help, since the host id is self-reported; the
  design's answer to a malicious host is the toggle plus verification at the dashboard, not sybil
  resistance, and the simulation counts such tiles as accepted lies rather than violations.
- The virtual node models what WP1.6's orchestrator must do on the wire (one presign per task's
  new hashes, then the result; reconnect as a new node; the four commands). The simulation can host
  the real orchestrator later by swapping the node model for it behind the same socket interface.
