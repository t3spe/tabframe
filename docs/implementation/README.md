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
