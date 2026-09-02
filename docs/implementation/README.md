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
| WP2.7 | [wp-2.7-deploy-m2.md](wp-2.7-deploy-m2.md) | 2026-09-02 | M2 on AWS: the editor compiles and launches on the cluster, word count exact, faults visible; seeding made idempotent |
| WP4.3 | [wp-4.3-pacing.md](wp-4.3-pacing.md) | 2026-09-02 | Pacing: exact interior shortcuts (106 s → 22 s, outputs unchanged), presets bounded to a 300 ms worst tile, word count measured, snapshot tasks pruned (2.2 MB → ~200 KB) |
