# WP1.7 — Control plane v1

**Milestone:** M1 · **Branch:** `wp/1.7-control-plane-v1` · **Packages:** `packages/control-plane`
(seeding, snapshots, adopt), `packages/store` (snapshot drivers), `packages/core` (tile size,
programs in the snapshot), `packages/protocol` (program view, rate limit), `packages/dev`

## What

The control-plane process now runs the machine the core describes, on a laptop and in the image:

- **Seeding** (`seed.ts`, design §5.6). At the first adopt of a ledger without programs, the
  demo programs under the programs directory — `/app/programs/<name>/program.wasm` in the image,
  `programs/<name>/dist/program.wasm` in the repo, `manifest.json` beside the module, optional
  inputs under `in/` as `/in/<file>` — are validated the way an upload is (`validateModuleBytes`:
  imports, exports, size, memory maximum) and put into the store: the module, the manifest, the
  inputs, and a **bundle**, which is a filesystem manifest blob over the fixed bundle paths. The
  ledger gets a `programAdded` event per program, so a seeded program launches exactly like an
  uploaded one. The configured default program (`TABFRAME_DEFAULT_PROGRAM`, Mandelbrot) becomes
  the machine's default loop unless the adopted ledger already has one. Invalid modules are
  logged and skipped, never seeded.
- **Snapshots** (`snapshotter.ts`, design §9.4). Every `TABFRAME_SNAPSHOT_MS` (five seconds) the
  ledger is serialized; when it changed since the last write it goes out gzipped under
  `g<generation>/<time>.json.gz` and again under `latest.json.gz`, the pointer the fleet reads
  when the previous control plane cannot hand over itself. The suspend and terminate hooks write
  unconditionally. Writes are serialized; failures are logged and reported in `/health`.
  Drivers: `MemorySnapshots` locally, `S3Snapshots` on the snapshot bucket (one-day expiry, the
  role already had read/write).
- **Adopt from snapshot in `/run`.** A run payload naming `snapshotKey` reads and decodes it
  (gzip or plain JSON), runs the core's `adoptLedger` (every node gone, their work released),
  restamps the generation and store base, and only then assumes the role. A missing or unreadable
  snapshot starts fresh — idempotency makes that safe — and is logged. The hook host's `onRun` is
  now asynchronous.
- **Private routes.** `GET /snapshot` serves the current ledger as JSON (M3's handover reads the
  same shape); `/health` adds programs, the running execution, the queue length, and the
  snapshotter's status.
- **Local topology.** `mise run dev` compiles the demo programs before the web bundle; the control
  plane seeds from `programs/` by default.
- **Tile size** (core, design §5.2). A result for a placed task of a `tiles` program whose
  `outputSize` is not `w × h × 4` becomes a program fault: the task fails with a message naming
  both sizes. Other views and unplaced tasks are not checked.
- **Programs in the snapshot** (protocol, core). A late observer used to learn programs only from
  `programAdded`, which seeding broadcasts before anyone is watching. Page 0 of the observer
  snapshot now carries `programs` (bundle, name, view, description, default params). The
  unused `counters` import that Biome had flagged since WP1.1 is gone.
- **Node message rate limit.** `LIMITS.nodeMessagesPerSecond` was 20. A node sends a presign and a
  result per task, and a Mandelbrot tile takes a few milliseconds, so honest nodes were being
  closed with code 4000 inside a second of starting. It is 1000 now. (The endpoint's 50 req/s
  limit is on HTTP requests; an open socket is one request.)
- **Whole milliseconds.** The node rounds `computeMs` — the sandbox measures with a
  high-resolution clock, and the wire's `millis` is an integer. Found by the end-to-end test.

The rest of the WP's list — execution lifecycle with one automatic continuation, planning as a
task with frozen hints, stage-spec validation and materialization, the `/out/<stage>/<i>`
filesystem with a manifest blob and the root on the execution, fold and continuation on `done`,
fan-out, controls, `presign` on the S3 driver — landed in the core (WP1.2) and the store
(WP1.3); this WP is where they first run together as a process, and the end-to-end test below is
their evidence.

## Tests

- `packages/store/src/snapshots.test.ts`: the memory driver; the S3 driver with a stubbed
  client (key, content type, round trip, not-found as null, other errors propagate).
- `packages/control-plane/src/seed.test.ts`: discovery of both layouts, inputs, directories
  without a module skipped; seeding puts every blob, builds the bundle manifest over the fixed
  paths, stores a shared module once, rejects the invalid module.
- `packages/control-plane/src/adopt.test.ts` (in-process control plane in image mode with
  injected stores): a named snapshot is adopted with programs and the default loop intact,
  nodes gone, generation moved, second `/run` refused; a missing key starts fresh and seeds the
  shipped Mandelbrot with its default loop; the suspend hook writes a gzipped snapshot plus the
  latest pointer; unchanged ledgers are not rewritten; forced writes are; `/snapshot` and
  `/health` report; an unreadable snapshot starts fresh.
- `packages/control-plane/src/mandelbrot.test.ts`, **the M1 pipeline on a laptop**: the real
  control-plane process seeds Mandelbrot; an observer subscribes and sees the program in the
  snapshot; two local cores (the Node platform, real sandbox workers) join; the default loop
  launches; the frame's 640 `taskDone` events carry exactly the golden tile hashes; the
  execution ends with follow-up params; the next execution starts by itself with those params
  (D19); snapshots were written; `/snapshot` lists both executions. About 50 seconds, most of it
  compiling the program.
- `packages/core/src/tiles.test.ts` and `programs.test.ts`: the size check both ways; programs
  on snapshot page 0.

Suite: 279 tests, 94 % of lines; lint and the three type-check projects green.

## Why this shape

- Seeding through the same `programAdded` event as uploads keeps one launch path and lets the
  snapshot carry seeded programs like any other — an adopting control plane does not reseed.
- Bundles are manifest blobs so a program is one hash and its inputs (the word-count corpus in
  M2) travel with it under `/in/`.
- The snapshotter compares serialized JSON rather than tracking dirtiness across the core: the
  ledger is small (thousands of tasks at most), and correctness beats a flag that could be missed.
- `latest.json.gz` is overwritten in place; the bucket's expiry deletes the dated keys, and the
  fleet function only ever needs the latest.

## Left for later

- The dashboard fork (WP1.8) reported that the planner's task is counted in `done`, so chips show
  301 for 300 tiles; that the `controlApplied` for `setRedundancy` carries no value; and that
  `subscribe{since}` is ignored. Small protocol and core follow-ups, queued for dashboard v2.
- The snapshot bucket's `latest` pointer is read by the fleet in M3 (WP3.2).
