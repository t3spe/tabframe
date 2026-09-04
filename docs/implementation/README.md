# Implementation log

One document per work package, written on the WP's branch and merged with it. Each covers what was
delivered, how it works, why it is built that way, the evidence, any design drift, and open items.
Screenshots and other evidence live under `assets/wp-<m>.<n>/`.

| WP | Document | Merged | Summary |
|---|---|---|---|
| WP0.1 | [wp-0.1-repo-scaffold.md](wp-0.1-repo-scaffold.md) | 2026-09-01 | Workspace, tooling, guard task, docs, license |
| WP0.2 | [wp-0.2-protocol.md](wp-0.2-protocol.md) | 2026-09-01 | Envelope, M0 messages, close codes, limits, canonical codec |
| WP0.3 | [wp-0.3-core.md](wp-0.3-core.md) | 2026-09-01 | Ledger, apply(event) → effects, liveness sweep, refusals, interfaces |
| WP0.4 | [wp-0.4-control-plane.md](wp-0.4-control-plane.md) | 2026-09-01 | Process: two listeners, sockets → core, hooks, local store, session emulation |
| WP0.12 | [wp-0.12-ci.md](wp-0.12-ci.md) | 2026-09-01 | GitHub Actions: lint, unit, browser tests on every push; nightly simulation; no AWS in CI |
| WP0.5 | [wp-0.5-node.md](wp-0.5-node.md) | 2026-09-01 | Orchestrator: session, hello, heartbeat, reconnect with backoff and rotation delay; web and Node platforms |
| WP0.6 | [wp-0.6-web.md](wp-0.6-web.md) | 2026-09-01 | Host page: session states, observer client, node table, local nodes, controls; Playwright acceptance |
| WP0.7 | [wp-0.7-dev.md](wp-0.7-dev.md) | 2026-09-01 | `mise run dev`: control plane, two local cores, web watch, one-command teardown |
| WP0.9 | [wp-0.9-fleet-skeleton.md](wp-0.9-fleet-skeleton.md) | 2026-09-01 | Session and rotate v0 functions, pointer, operator scripts, fakes and SDK-mock tests |
| WP0.8 | [wp-0.8-infra-skeleton.md](wp-0.8-infra-skeleton.md) | 2026-09-01 | CDK stacks Core, Image, Fleet; image staging dir with placeholder process; base-image resolver; synth tests |
| WP0.10 | [wp-0.10-first-hello.md](wp-0.10-first-hello.md) | 2026-09-02 | First deploy: four stacks, control plane in a MicroVM, page on CloudFront, browser nodes through the proxy |
| WP1.1 | [wp-1.1-protocol-v1.md](wp-1.1-protocol-v1.md) | 2026-09-02 | Full wire vocabulary: assign/result/presign, controls, events, views, manifests; ABI byte formats |
| WP1.2 | [wp-1.2-core-v1.md](wp-1.2-core-v1.md) | 2026-09-02 | Scheduler: tiers, deadlines, speculation, verification, execution lifecycle, controls, snapshots, invariants |
| WP1.3 | [wp-1.3-store.md](wp-1.3-store.md) | 2026-09-02 | Store package: local and S3 drivers with pinned checksums, the shared client; control plane executes store effects |
| WP1.4 | [wp-1.4-sandbox.md](wp-1.4-sandbox.md) | 2026-09-02 | WebAssembly sandbox: validation, the five tf imports, filesystem glue, deadline kill, Node and web adapters |
| WP1.5 | [wp-1.5-sdk-mandelbrot.md](wp-1.5-sdk-mandelbrot.md) | 2026-09-02 | AssemblyScript SDK mirroring the ABI, Mandelbrot program with presets and goldens, build and host scripts |
| WP1.6 | [wp-1.6-node-v1.md](wp-1.6-node-v1.md) | 2026-09-02 | Node orchestrator: task loop, module and manifest caches, sandbox with grace deadline, uploads via presign, cancel and commands, `released` results |
| WP1.7 | [wp-1.7-control-plane-v1.md](wp-1.7-control-plane-v1.md) | 2026-09-02 | Control plane: seeding of shipped programs, gzipped S3 snapshots with a latest pointer, adopt-from-snapshot in `/run`, the M1 pipeline end to end |
| WP1.8 | [wp-1.8-dashboard-v1.md](wp-1.8-dashboard-v1.md) | 2026-09-02 | Dashboard: verified tiles on the canvas with state overlay, task grid, counters, throughput, controls over the socket, notices, demo mode |
| WP1.9 | [wp-1.9-churn-sim.md](wp-1.9-churn-sim.md) | 2026-09-03 | Churn simulation: virtual nodes running real WASM on a virtual timeline, seeded chaos, invariants after every event, goldens per frame; four control-plane fixes it found |
| WP1.10 | [wp-1.10-deploy-m1.md](wp-1.10-deploy-m1.md) | 2026-09-02 | M1 on AWS: signed-checksum presigns, default-loop backoff, execution pruning, the M1 runbook — 640 of 640 golden tiles from browser tabs through a kill-half |
| WP2.1 | [wp-2.1-filesystem.md](wp-2.1-filesystem.md) | 2026-09-02 | Execution filesystem: bundle files as the first root, persist inheritance, expired-root warning, per-execution size cap |
| WP2.2 | [wp-2.2-wordcount.md](wp-2.2-wordcount.md) | 2026-09-02 | Word count: three-stage map/reduce/merge over Moby-Dick with range ownership by word start, FNV-1a partitions, the `bars` payload, a staged host and goldens |
| WP2.3 | [wp-2.3-launch-path.md](wp-2.3-launch-path.md) | 2026-09-02 | Launch path: uploaded bundles resolved and validated by the process, per-execution task budget, per-observer launch rate |
| WP3.1 | [wp-3.1-cp-lifecycle.md](wp-3.1-cp-lifecycle.md) | 2026-09-02 | Rotation, control-plane side: phases, handover, generation-guarded adopt, jittered drain, fleet-secret gate |
| WP3.2 | [wp-3.2-fleet-v1.md](wp-3.2-fleet-v1.md) | 2026-09-02 | Rotation, fleet side: the five steps, the private-port client, failure paths, and repair of an interrupted rotation |
| WP2.4 | [wp-2.4-editor.md](wp-2.4-editor.md) | 2026-09-02 | In-page editor: asc in a lazily loaded worker (byte-identical to the build), prefilled Mandelbrot, diagnostics with lines, params, compile → bundle → launch over the observer socket, the drop-a-`.wasm` door |
| WP3.3 | [wp-3.3-cloud-cores.md](wp-3.3-cloud-cores.md) | 2026-09-02 | Cloud cores: the fleet and sleep policies in the pure core, core records in the ledger, the image running the same orchestrator a tab runs |
| WP2.5 | [wp-2.5-dashboard-v2.md](wp-2.5-dashboard-v2.md) | 2026-09-02 | Dashboard v2: programs panel with launch forms, queue with drop, stage strip, bars and text views, files panel by root with previews, task detail with attempts and log, failure and warning surfacing |
| WP3.4 | [wp-3.4-handover-tests.md](wp-3.4-handover-tests.md) | 2026-09-02 | A real rotation on a laptop: the local driver behind `dev:rotate`, and a two-process handover taken mid-render as a test |
| WP3.5 | [wp-3.5-deploy-m3.md](wp-3.5-deploy-m3.md) | 2026-09-02 | M3 on AWS: rotation under load measured at 8.4 s of churn, the bundled sandbox worker, retries for throttled fleet calls, the endpoint's socket ceiling |
| WP2.6 | [wp-2.6-playwright-v1.md](wp-2.6-playwright-v1.md) | 2026-09-02 | Browser suites: the money shot (ten nodes, kill half, 640 golden tiles) and the sandbox's deadline kill and trap paths |
| WP5.1 | [wp-5.1-packaging.md](wp-5.1-packaging.md) | pending | Packaging: the README for a cold reviewer, the rationale draft answering the five questions, and the scrubbing transcript export tool behind `mise run transcripts` |
| WP2.7 | [wp-2.7-deploy-m2.md](wp-2.7-deploy-m2.md) | 2026-09-02 | M2 on AWS: the editor compiles and launches on the cluster, word count exact, faults visible; seeding made idempotent |
| WP4.1 | [wp-4.1-dashboard-polish.md](wp-4.1-dashboard-polish.md) | 2026-09-02 | Dashboard polish: flashes for every move with a pulse log, a released colour and a full legend, rotation and sleep banners with countdown and generation, a throughput chart, a spawn hint sized to the browser, the ledger panel of hashes and store locations |
| WP4.2 | [wp-4.2-operations.md](wp-4.2-operations.md) | 2026-09-02 | Operations: /health and /diag complete, log retention, the runbook, operator tasks; the platform forwards only a process's first log line |
| WP4.3 | [wp-4.3-pacing.md](wp-4.3-pacing.md) | 2026-09-02 | Pacing: exact interior shortcuts (106 s → 22 s, outputs unchanged), presets bounded to a 300 ms worst tile, word count measured, snapshot tasks pruned (2.2 MB → ~200 KB) |
| WP4.5 | [wp-4.5-endpoint-ceiling.md](wp-4.5-endpoint-ceiling.md) | 2026-09-02 | The endpoint ceiling explained: 16 concurrent connections per MicroVM, a non-adjustable quota; the M0 count was wrong; decision to document now and evaluate EC2 after M5 |
| WP4.8 | [wp-4.8-ci-green.md](wp-4.8-ci-green.md) | 2026-09-02 | CI green after 23 red runs (programs built on demand and in CI, two browser flakes) and the hard rule: green `main` before the next work package |
| WP4.9 | [wp-4.9-seeding-snapshot-diet.md](wp-4.9-seeding-snapshot-diet.md) | 2026-09-02 | Seeding retires a superseded shipped program and moves the default loop; ended executions lose their file maps with their tasks, inheritance reads the root's manifest |
| WP4.4 | [wp-4.4-unattended-demo.md](wp-4.4-unattended-demo.md) | 2026-09-02 | The demo script runs unattended against the deployed machine (`mise run demo`); first runs fixed the fleet policy for killed, frozen, and never-linked cores |
| WP6.1 | [wp-6.1-stop-start.md](wp-6.1-stop-start.md) | 2026-09-02 | Stop and Start from the page: the running execution ends, the loop's queued frames go, the loop waits for Start across snapshots and rotations |
| WP6.4 | [wp-6.4-editor-tab-pause.md](wp-6.4-editor-tab-pause.md) | 2026-09-03 | The editor in its own tab; pause and resume — the tab holds the machine paused while it lives, launching or closing resumes |
| WP6.3 | [wp-6.3-panel-tabs.md](wp-6.3-panel-tabs.md) | 2026-09-03 | The ledger, files, and activity panels summarise on the dashboard and open full-width in their own tabs, each under an explanation of what it is |
| WP6.2 | [wp-6.2-layout-stability.md](wp-6.2-layout-stability.md) | 2026-09-03 | Nothing changes size: every dynamic region keeps a reserved box; a layout test in demo mode and at every beat of the unattended demo |
| WP6.6 | [wp-6.6-editor-guide.md](wp-6.6-editor-guide.md) | 2026-09-03 | The editor explains itself: the SDK's README as a guide, the machine's limits, and three examples to load (Mandelbrot, hello, word count) |
| WP6.7 | [wp-6.7-rotation-observations.md](wp-6.7-rotation-observations.md) | 2026-09-03 | The rotation observations: a stale pending successor is no longer promoted over a serving control plane; the hourly rule skips a rotation minutes after the last |
| WP6.5 | [../feasibility-transformer.md](../feasibility-transformer.md) | 2026-09-03 | A small transformer in WASM: the assessment with measured numbers, and `programs/tinygpt` — a 0.8 M-parameter GPT predicting the next byte on the cores, equal to its PyTorch reference |
| WP6.8 | [wp-6.8-review-fixes.md](wp-6.8-review-fixes.md) | 2026-09-03 | Mircea's review of the deployed page: Stop always in the header, the loop yields to people (nothing launches after a person's run until Start or ten idle minutes), the top of the page on a fixed grid, whole hashes and addresses in the ledger, a freeze toggle on the panel tabs, file names that open the file. |
| WP7.1 | [wp-7.1-stop-start-loop-pill.md](wp-7.1-stop-start-loop-pill.md) | 2026-09-03 | The header's one slot means "what you can do to the machine now" (Stop while anything runs, Start when idle and held, Resume while paused); a loop pill says the loop's state; Stop says what it will do and what it did. |
| WP7.2 | [wp-7.2-throughput-rows.md](wp-7.2-throughput-rows.md) | 2026-09-03 | The throughput chart is one crisp line on a slow, named scale with a caption; the counters sit in two rows, the redundancy toggle on its own line, the flashes on one line of text. |
| WP7.3 | [wp-7.3-launch-form-focus.md](wp-7.3-launch-form-focus.md) | 2026-09-03 | The programs panel keeps one row per program and one launch form per open program, updated in place; typing params no longer loses the caret; params are parsed on blur and on launch. |
