# Tabframe — Execution Plan

**Status:** written 2026-09-01 from [`design.md`](design.md). The design record is the contract; this
plan is the order of work. When the two disagree, fix the design record first, then the plan.

**Where we are (2026-09-02):** M0 complete and tagged `m0` — deployed, public, verified. M1 in progress: WP1.1–1.6 merged (protocol, core, store, sandbox, SDK + Mandelbrot, node orchestrator); WP1.8 dashboard v1 and WP1.9 churn simulation in worktrees; WP1.7 control-plane v1 next, then WP1.10 deploy.

**Shape of the plan:** six milestones, M0–M5, each ending in a deployable checkpoint. Each milestone
is a set of work packages (WP). A WP is done when its code, its tests, its WP document under `docs/implementation/`, and its doc touch
are merged together and its acceptance line holds. Checkboxes are updated in the same commit that
completes the WP.

---

## 0. Ground rules for the build

- **Every session starts the same way:** read `design.md` and this plan, run `mise run whoami`. Nothing touches AWS before the guard passes.
- **AWS identity:** profile `tabframe` only, set by mise and passed explicitly on ad-hoc calls. No fallback to any other profile — stop and ask.
- **Independence first.** The build is optimized for uninterrupted work: I stop and ask only when I genuinely cannot proceed. Everything already agreed in the design record and this plan proceeds without asking — `cdk bootstrap`, the first deploy with the budget, enabling the hourly schedule at M3 included. Non-blocking questions go into the WP report's Open line and work continues.
- **Hard stops** (the only ones): destructive or irreversible actions — deleting stacks, buckets, or data, rewriting pushed history, `mise run down`; spending outside the agreed design or budget; contradicting a decision Mircea explicitly owns; and gates only he can pass, such as flipping the repo public.
- **Transcript hygiene:** commands whose output can contain an account id, token, presigned URL, or address write raw output to the scratchpad; only a masked summary reaches the conversation.
- **Git flow:** a branch per WP, `wp/<m>.<n>-<slug>`, pushed as work progresses. Never commit directly to `main`. When lint and tests are green, I merge the branch into `main` myself with a `--no-ff` merge commit, push, and delete the branch. Commit messages name the WP (`M1/WP1.4 sandbox: deadline kill`). Goldens change in the same commit as the kernel that changed them. History on `main` is never rewritten.
- **WP document:** every WP lands `docs/implementation/wp-<m>.<n>-<slug>.md` on its branch, and no WP is done without it. Sections: **What** was delivered, **How** it works (key modules, interfaces, the shape of the code), **Why** it is built that way (alternatives considered, links to the design sections it implements), **Evidence** (tests, commands, screenshots under `docs/implementation/assets/`), **Drift** recorded in the design record, **Open** items. The chat report is a condensation of this file.
- **Time log:** `docs/timelog.md` gets one line per session with two columns — **developer time** (Mircea's hours) and **total time** (wall-clock of the session, agent included) — starting with the design day (2026-09-01). The rationale states the developer total honestly and shows the total alongside it.
- **Design drift:** any deviation discovered while building is recorded in `design.md` as a dated entry before the code lands, and work continues. Only a drift that contradicts an explicit decision waits for Mircea.
- **Review mode:** merge-when-green. Each WP merges into `main` when lint and tests pass and is reviewed after the fact, on GitHub or in the WP document. Independent WPs may run in parallel on their own branches; each still merges separately with its own report (Built / Verified / Drift / Open / Next).

---

## 1. Dependency map

```
 protocol ──► core ──► control-plane (local mode) ──► dev topology
     │          │              │
     │          │              └──► store (local driver) ──► S3 driver (deploy)
     │          │
     ▼          ▼
   node ◄── sandbox ◄── sdk-as ◄── programs (mandelbrot, wordcount)
     │
     ▼
    web (host, dashboard, editor)          infra (CDK) ──► image ──► fleet (session, rotate)
                                                                   │
                                           churn simulation ◄──────┘  (real WASM under Node)
```

Infra, image, and fleet skeletons run in parallel with the core in M0. Everything above the line
`programs` is exercised by the churn simulation from M1 on.

---

## 2. M0 — Skeleton and verification

**Goal:** a public URL answers with hello/heartbeat from a control plane in a MicroVM; `mise run dev` shows tabs and two local cores joining and leaving; the ten unknowns are retired and their answers folded into `design.md`.

- [x] **WP0.1 Repo scaffold.** `mise.toml` (§11.2 of design), root `package.json` with Bun workspaces, `tsconfig.base.json`, `biome.json`, `.gitignore` (`node_modules`, `dist`, `cdk.out`, `cdk.context.json`, `.env.local`, `playwright-report`), `.env.local` written locally with `TABFRAME_ACCOUNT_ID` and `TABFRAME_BUDGET_EMAIL` — never committed; `LICENSE` (AGPL-3.0); `erasableSyntaxOnly` in the base tsconfig. README updated to point at `docs/`. `docs/design.md`, `docs/plan.md`, `docs/timelog.md` (seeded with the design day) committed.
  *Acceptance:* `mise install`, `bun install`, `mise run whoami` passes with the account id masked in output.
- [x] **WP0.2 `protocol` skeleton.** Envelope `{t, v, gen}`; zod schemas for `hello`, `welcome`, `heartbeat`, `subscribe`, `snapshot` (nodes only for now), `ping`/`pong`, `error`; close codes; limits constants; canonical JSON codec.
  *Acceptance:* round-trip tests; invalid, oversized, and foreign-generation messages rejected.
- [x] **WP0.3 `core` skeleton.** Ledger types for node, observer, meta; `Clock`, `Transport`, `Store` interfaces; `apply(ledger, event, now)` for hello, heartbeat, disconnect, subscribe, ping, tick; liveness sweep (gone at 4 s); events `nodeJoined`/`nodeLeft`; sequence numbers.
  *Acceptance:* unit tests with a fake clock; a node that stops heartbeating is gone at 4 s and its connection-close effect is emitted.
- [x] **WP0.4 `control-plane` process, local mode.** Node `http` + `ws` with two listeners, public and private (8080/8081 in the image; 4080/4081 by default locally, since 8080 is taken on the dev machine; both env-configurable) — public for sockets and static, private for `/health`, `/diag`, the lifecycle hook routes at `/aws/lambda-microvms/runtime/v1/{ready,validate,run,resume,suspend,terminate}` (log and 200; `run` reads role and payload), and later the fleet endpoints; **neutral boot state** until `/run`; observer and node sockets wired to `core`; `presign` as a socket message returning URLs to itself; local store routes `GET /blob/<hash>` and `PUT /blob/<hash>` (hashes, refuses mismatch); emulated `GET /session` including the off state.
  *Acceptance:* process test opens a real socket, completes hello/welcome, heartbeats, and sees itself in a snapshot.
- [x] **WP0.5 `node` orchestrator, minimal.** `platform/web.ts` (Web Worker) and `platform/node.ts` (Node process): take a session, connect, hello, heartbeat, reconnect with backoff, post `status` to the host. No sandbox yet.
  *Acceptance:* both platforms join the local control plane; killing the process shows `nodeLeft`.
- [x] **WP0.6 `web` minimal.** Host page: fetch session (handles waking, starting, and off), observer socket, node table with join/leave, spawn N, per-node close, `?observe` mode; `config.json` with the session URL.
  *Acceptance:* two tabs show each other's nodes live.
- [x] **WP0.7 `dev` topology.** `up.ts` starts the control plane under `node --watch`, two local cores, and `bun build --watch` for the web bundles.
  *Acceptance:* `mise run dev`, open the page, see the tab's node plus two cores; close the tab, the cores remain.
- [x] **WP0.8 `infra` skeleton (CDK).** Stacks in order: **Core** (buckets: artifacts, blobs, snapshots, web; CloudFront with S3 origins via OAC, `/blob/*` + `/` behaviors, error-caching TTL 0 on `/blob/*`; blob-bucket CORS allowing PUT with `x-amz-checksum-sha256` from the page's origin; one-year lifecycle on blobs; SSM pointer parameter with an off state; the budget from `TABFRAME_BUDGET_EMAIL`); **Image** (`CfnMicrovmImage` with a CDK asset zip of Dockerfile + `main.js` + programs dir, **hooks on port 8081**, environment variables for bucket names and pointer name only — nothing fleet-related, build role reading the asset bucket, control-plane and core execution roles per design §10.1); **Fleet** (session and rotate `NodejsFunction`s, function URL with CORS for GET, modest reserved concurrency on session, hourly EventBridge rule created **disabled**, roles). Base image version resolved by a small script and passed as context (currently `1` for `al2023-1`). Build and execution roles trust `lambda.amazonaws.com` for `sts:AssumeRole` and `sts:TagSession`; control-plane and fleet roles get the `lambda:*Microvm*` actions plus `iam:PassRole`.
  *Gates:* `cdk bootstrap` confirmation; first deploy confirmation (budget).
  *Acceptance:* `cdk synth` test passes; `cdk deploy --all` succeeds; the image version reaches ACTIVE (build logs tailed).
- [x] **WP0.9 `fleet` skeleton.** Shared MicroVM client (`@aws-sdk/client-lambda-microvms` — confirm the package at this step), pointer read/write, `session` handler (pointer → off state, or get MicroVM → one shared token per control plane cached for 25 minutes → `{endpoint, token, expiresAt, storeBase, generation}`), `rotate` v0 (idempotent: check pointer and running MicroVMs, launch a control plane if none, wait for run hook, set pointer — no handover yet), scripts `rotate.ts`, `up.ts`, `down.ts` (disable schedule, terminate all, write off).
  *Acceptance:* tests against a fake client; `mise run deploy` ends with a session URL that returns a live endpoint.
- [x] **WP0.10 First public hello.** Page from CloudFront connects to the MicroVM control plane through the session token; hello/heartbeat visible in the dashboard and in CloudWatch.
  *Acceptance:* a second browser on another network sees the first browser's node join.
- [x] **WP0.11 `mise run verify`.** `verify-m0.ts` with masked output, one check per unknown, each with a pass criterion and the design fallback:

| Check | Method | Pass | Fallback |
|---|---|---|---|
| Frames count as idle traffic | connect, send frames past `maxIdleDurationSeconds`, read state | still RUNNING | observer ping becomes an HTTP request |
| Socket survives token expiry | 1-minute token, connect, wait 2 minutes | socket open | 60-minute tokens, reconnect at 55 |
| Endpoint 429 threshold | ramp request rate, record first 429 | ≥ 50 req/s | coalesce events per observer, heartbeat 2 s |
| DNS and S3 inside the image | `/diag` resolves a name and HEADs the blob bucket | both OK | VPC egress connector |
| Resume latency at 1 GB | suspend by API, time first request | ≤ 5 s | smaller baseline or scheduled warm ping |
| Token-mint throttling | mint tokens in a burst, record first throttle | informational | tokens are already shared and cached |
| WebSocket connections per endpoint | open 300 sockets and hold them | ≥ 256 | lower node cap |
| Per-connection message rate | one socket at 50 msg/s for a minute | no throttling | batch heartbeats and events |
| Lambda concurrency | account settings; default 10, increase to 1000 requested 2026-09-01 | recorded | rotation jitter keeps session calls under 10 regardless — measured at WP3.5 |
| Account memory quota | Service Quotas read | ≥ 8 GB (known) | request increase |

  *Acceptance:* `docs/m0-verification.md` written; any triggered fallback recorded in `design.md` before M1 starts.
- [x] **WP0.12 CI.** GitHub Actions on the private repo: mise install, `bun install`, `mise run lint`, `bun test`, Playwright with cached Chromium. No AWS credentials in CI.
  *Acceptance:* green on a push that touches every package.

**M0 done when:** the public URL answers; dashboard shows real tabs joining across networks; `mise run dev` runs the local topology; verification results are in the docs; `mise run down` leaves nothing running.

---

## 3. M1 — The machine

**Goal:** Mandelbrot renders across tabs and local cores as a real program; kill half on a laptop and on AWS, the image completes and hashes match goldens; the churn simulation passes.

- [x] **WP1.1 `protocol` v1.** `assign`, `result` (hashes; error form), `cancel`, `command`; task events; snapshot pages with tasks; controls `killHalf`, `freezeHalf`, `throttleHalf`, `resumeAll`, `restart`, `setRedundancy`; limits for inline input and pages.
- [x] **WP1.2 `core` v1.** Executions, tasks, attempts; fill with three tiers; deadlines (3× rolling median, floor 2 s); release on gone; speculation; both verification policies including contested → recompute → vote after two rounds; result identity (output + sorted writes); health labels; counters; snapshot serialize/deserialize; victim selection with the injected random source; redundancy toggle; an `invariants.ts` checker used by tests and the simulation.
  *Acceptance:* every invariant in design §6.10 has a failing test if you break it.
- [x] **WP1.3 `store`.** Local driver (hashing PUT, GET with Range); S3 driver (presign with pinned SHA-256 checksum and immutable cache-control for key = hash, existence check); presign served as a socket message; browser-side SHA-256 via `crypto.subtle`; one client flow in `node` and `web`.
  *Acceptance:* a PUT with wrong bytes is refused by both drivers.
- [x] **WP1.4 `sandbox`.** ABI loader (instantiate, `alloc`, `run`/`plan` convention); imports glue `stat`/`read`/`write`/`list`/`log`/`abort` with manifest resolution and own-writes overlay; caps; upload-time validation of imports, exports, size, declared memory max; web adapter (sync XHR) and node adapter (`Atomics.wait` + orchestrator fetch service); fresh instance per task; deadline kill by worker terminate. Fixtures compiled at test time: infinite loop, memory hog, trap, forbidden import.
  *Acceptance:* the loop is killed at the deadline on both adapters; the forbidden import is rejected before instantiation; two runs of the same input yield identical bytes.
- [x] **WP1.5 `sdk-as` + Mandelbrot program.** SDK (`fs.*`, `log`, codecs, stage builder); Mandelbrot `plan` (one stage, 640 tasks, placement, full frame params per task, presets chosen here) and `run` (RGBA, smooth coloring in WASM, no NaN); manifest; `build-programs.ts` with the maximum-memory compiler flag; `goldens.ts`.
  *Acceptance:* goldens committed; plan output validates against the stage-spec schema; single-node run reproduces goldens under Node.
- [x] **WP1.6 `node` orchestrator v1.** Module and manifest caches by hash; sandbox lifecycle; deadline timer; upload output/writes/log via presign then `result`; commands `close`/`freeze`/`throttle`/`resume`; visibility relay; reconnect with a fresh session; status states. Same code on both platforms.
- [ ] **WP1.7 `control-plane` v1.** Seeding (demo bundles from `/app/programs` into the store on first adopt); execution lifecycle with one automatic continuation; **planning as a task** with frozen hints; stage-spec validation and materialization; minimal filesystem (outputs to `/out/<stage>/<i>`, manifest blob, root on the execution); fold and continuation on `done` (default loop only); fan-out; controls; RGBA size validation for tiles; S3 snapshot writer every 5 s when changed, gzipped, plus hooks; adopt-from-snapshot in `/run`; `presign` socket handler on the S3 driver.
  *Acceptance:* a restart of the local process mid-frame resumes from its snapshot and the frame completes with matching hashes.
- [ ] **WP1.8 `web` dashboard v1.** Canvas for the tiles view (offscreen at computed size, drawn at half); task grid with the seven states; node table with health; throughput from `taskDone` timestamps; counters; controls (spawn local; kill/freeze/throttle/resume cluster-wide; restart; redundancy toggle); "your nodes" panel; consent banner with stop-lending; waking and starting states.
- [ ] **WP1.9 Churn simulation.** Harness in `core`: virtual nodes running real WASM through the node sandbox adapter, seeded event generator (join, leave, freeze, throttle, kill), virtual clock, fake store, invariants after every event, goldens comparison, lying-node and redundancy-on scenarios, `mise run sim --seed N`, default few seeds and a long mode.
  *Acceptance:* 1 000 seeds pass in long mode.
- [ ] **WP1.10 Deploy M1.** Image with programs; on AWS with tabs only (cloud cores arrive in M3): kill half, image completes, canvas hash equals golden.

**M1 done when:** the money shot works on a laptop with local cores and on AWS with real tabs; the simulation passes; the dashboard shows reassignment, speculation, and verification live.

---

## 4. M2 — Programs

**Goal:** a reviewer edits the Mandelbrot source in the page, compiles in the browser, launches, and the cluster runs it; word count runs as a three-stage program.

- [ ] **WP2.1 Filesystem complete.** Write buffering, upload, commit on acceptance, conflict detection at fold, `list`, `stat`, own-writes overlay, inherit at launch (`persist` → latest), expired-root fallback with warning, per-task and per-execution caps, result identity including writes.
- [ ] **WP2.2 Word count program.** Map (byte ranges extended to whitespace, eight partitions by fixed hash), reduce (read `/out/0/*`, slice partition, merge), merge (global top-K); corpus chosen here (Moby-Dick from Project Gutenberg via the cache URL or the pglaf mirror, both reachable in preflight; boilerplate stripped), attribution file; goldens against a JavaScript reference count; `bars` view.
- [ ] **WP2.3 Launch path.** Bundle upload from the page via presign; `launch` with validation; queue priority (human ahead of automatic); `skip`, `killExecution`; follow-ups of human executions offered via `executionDone` and `runFollowUp`, never auto-enqueued, then back to the default loop; per-execution budgets (task cap, compute-seconds), per-observer launch rate, caps of 256 nodes and 64 observers; program records and `programAdded`; execution failures for trap, over budget, conflict, invalid spec.
- [ ] **WP2.4 Editor.** AssemblyScript compiler bundled for the browser with its Node-only imports stubbed (verified in Chromium in preflight: ~7 s load unminified, ~0.4 s compile), minified and split from binaryen, loaded lazily in a worker; prefilled Mandelbrot source with the SDK; diagnostics panel; params editor seeded from manifest defaults; compile → bundle → launch; the drop-a-`.wasm` door.
- [ ] **WP2.5 Dashboard v2.** Programs panel, queue view, stage strip, `bars` and `text` views, files panel (browse an execution's filesystem by root), task detail with log and attempts, execution failure surfacing.
- [ ] **WP2.6 Playwright v1.** Money shot; editor compile and launch; web sandbox adapter tests. Chromium is installed; three optional font packages missing on the dev machine only affect non-Latin glyphs.
- [ ] **WP2.7 Deploy M2.**

**M2 done when:** an edited program runs on AWS from the page; word count completes with the right top-K; a program fault fails its execution visibly and the machine moves on.

---

## 5. M3 — Fleet

**Goal:** the control plane rotates hourly under load on AWS with the render continuing; two cloud cores come and go with the machine's sleep policy; deploys are rotations.

- [ ] **WP3.1 Control-plane lifecycle for real.** `/run` reads role, generation, snapshot key; `/suspend` and `/terminate` flush snapshots; `/resume` revalidates; `/handover`, `/adopt`, `/drain` on port 8081, gated by a fleet token and the fleet secret from the payload; drain closes clients with the rotating code plus a jittered reconnect delay sized to the client count (30 ms per client, ≥ 2 s); generation stamping and rejection; `controlPlaneRotating`; rotating-reconnect close code.
- [ ] **WP3.2 Fleet v1.** Full handover protocol with failure paths and repair-on-next-run; session heals through rotate unless the pointer says off; hourly schedule **enabled** (gate); reserved concurrency 1; idempotency under concurrent heal requests; `rotate.ts`, `up.ts`, `down.ts` finished.
  *Acceptance:* fake-client tests for every branch; a real rotation on AWS with a render in flight completes the frame with matching hashes.
- [ ] **WP3.3 Cloud cores.** Node platform hardened (session fetch, reconnect, Atomics read path under load); core role in the image; fleet policy in the control plane (desired 2 while awake, one launch per second, replace on death or age, core ids kept in the ledger and inherited at adopt); sleep policy (10 min without observers; 60 min without interaction); `machineSleeping`; wake on first visitor; core killed by a demo control is replaced.
- [ ] **WP3.4 Handover tests.** `dev:rotate` local driver; two-process handover integration test; Playwright rotation-mid-render test.
- [ ] **WP3.5 Deploy M3.** Measure churn seconds per rotation under load and record them; confirm from CloudWatch that the session function's concurrent executions stay under 10 with no throttles during a rotation with a few hundred simulated clients.

**M3 done when:** the dashboard shows the generation change at the top of the hour while tiles keep landing; cores appear on wake and vanish on sleep; `mise run deploy` is a rotation.

---

## 6. M4 — Polish and observability

**Goal:** the five-minute demo script runs unattended in Playwright; the dashboard explains itself.

- [ ] **WP4.1 Dashboard polish.** Reassignment flashes, state colors and legend, rotation banner with countdown and generation, throughput chart, core-count hint on spawn, waking states, files and ledger panels finished.
- [ ] **WP4.2 Operations.** `/health` and `/diag` complete; log groups named; runbook `docs/runbook.md` (deploy, rotate, rollback, down, verify); budget confirmed firing on a test threshold.
- [ ] **WP4.3 Performance and pacing.** Frame pacing about a minute per frame single-node; tile timing; reduce read batching if word count is slow; snapshot size and resume latency.
- [ ] **WP4.4 Unattended demo.** Playwright runs the whole demo script; simulation long mode in CI nightly.

**M4 done when:** the demo script passes unattended three times in a row against AWS.

---

## 7. M5 — Package

**Goal:** submitted.

- [ ] **WP5.1 README** final: what, why, architecture, in and out of scope, run, deploy.
- [ ] **WP5.2 Rationale doc:** the five required questions, time spent from `docs/timelog.md` stated plainly, the scoping choice owned.
- [ ] **WP5.3 Video:** record the demo script with narration, about five minutes.
- [ ] **WP5.4 Transcripts** into `docs/transcripts/` — export mechanism to be decided then.
- [ ] **WP5.5 Pre-public checks:** secrets scan of the full history, the AGPL-3.0 license file, corpus attribution, `.env.local` absent, no account id or address anywhere, CDK context excluded.
- [ ] **WP5.6 Public** (gate: Mircea flips the repo), final deploy, submission checklist.

---

## 8. Risk register

| Risk | Where it bites | Mitigation | Owner WP |
|---|---|---|---|
| Endpoint 429 thresholds are strict | heartbeats and fan-out | coalesce events per observer; heartbeat 2 s | WP0.11 → WP1.7 |
| Frames don't count as idle traffic | control plane suspends mid-demo | observer ping becomes HTTP | WP0.11 → WP0.6 |
| Sync XHR in workers changes | browser read path | declared-prefetch fallback in the sandbox glue | WP1.4 |
| Token-mint throttling | wake with many visitors | one shared token per control plane, cached | WP0.9 |
| Lambda concurrency default of 10, endpoint ~50 req/s | session function and socket upgrades during a rotation reconnect storm | drain-time jitter window (30 ms per client, ≥ 2 s) plus the shared cached token; measured in M0 | WP3.1 → WP3.5 |
| Rotation coincides with a live demo | reviewer confusion | banner with countdown; explained in the video | WP4.1 |
| Word count reduce is slow | 150 reads per reducer | fewer, larger map chunks; batch reads | WP4.3 |
| AssemblyScript compiler size (23 MB unminified) | editor first open | minify, split binaryen into its own asset, lazy load in a worker with progress | WP2.4 |
| WASM NaN payload bits | verification false mismatches | SDK forbids NaN output; goldens cover it | WP1.5 |
| Cost runaway | any fleet bug | sleep policy, max durations, budget, `mise run down` | WP3.3 |
| Package or construct names differ from the docs | M0 infra | confirm `@aws-sdk/client-lambda-microvms` and `CfnMicrovmImage` at WP0.8/0.9 | WP0.8 |

---

## 9. Tracking

Progress lives in this file's checkboxes and in `docs/timelog.md`. Milestone checkpoints are tagged in git (`m0`, `m1`, …). The design record is updated before the plan whenever building teaches us something.
