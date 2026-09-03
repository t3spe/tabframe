# Tabframe — Design Record

**Status:** design complete, build not started. Written 2026-09-01 during a full pre-build walkthrough.
This document is the source of truth for the build. It supersedes the earlier handoff and seed
documents wherever they differ.

**One line:** a fault-tolerant distributed computer whose cores are browser tabs and Firecracker
microVMs, programmed with WebAssembly modules, whose control plane holds only metadata and hashes,
and which stays correct while cores — and the control plane itself — come and go.

---

## Contents

1. Decisions register
2. The system in one page
3. Runtime picture
4. Nodes
5. Programs
6. The control plane
7. Data paths and the store
8. The wire
9. Hosting and fleet
10. Security and credentials
11. Tooling and repo
12. Tests and dev loop
13. Deploy, operations, and the reviewer's view
14. Milestones
15. Rationale hooks
16. Glossary
17. Drift log

---

## 1. Decisions register

| # | Decision | Notes |
|---|----------|-------|
| D1 | **Scope:** everything in the original handoff, plus straggler speculation, duplicate-result verification with a built-in redundancy toggle, a program ABI, and MapReduce word count. Time is not a design constraint. | The handoff's 8-hour line did not drive any choice here; §15 says how the rationale owns that. |
| D2 | **General-purpose programs, minimal but complete.** A program is one WASM module (`plan` + `run`) plus a manifest, content-addressed, sandboxed, uploadable, with in-browser AssemblyScript compilation and an execution queue. | Mandelbrot and word count are real programs shipped through the same path; the node bundle contains no application code. |
| D3 | **Node = one orchestrator worker owning its own socket + one disposable sandbox worker.** The host page is an observer and a spawner only. | Heartbeats originate in the orchestrator; program compute never delays them. No iframes. |
| D4 | **One global machine.** Everyone joins one cluster. One execution runs at a time, FIFO, user-submitted ahead of automatic continuations. | Frames auto-advance while someone is watching. Zero nodes → tasks wait as pending. |
| D5 | **Hosting on AWS, tooling via mise.** | See D13. |
| D6 | **The control plane runs no program code.** Planning is a task executed on a core like any other. | Planning is fault-tolerant for free; stage specs are auditable blobs. |
| D7 | **Redundancy toggle built in.** A mismatch discards every result for the task and recomputes from scratch; the task is done only when two fresh attempts agree. After two contested rounds, the majority hash across all attempts wins and the tile is flagged red "resolved by vote". | Toggle off: a later disagreeing duplicate un-paints and recomputes. Toggle on: nothing is ever retracted. |
| D8 | **Ledger holds metadata and hashes only. Bytes live in a content-addressed store.** The store computes the hash on upload and refuses any other name. | The seed's control-plane / data-plane split, literally. |
| D9 | **Results, written files, and logs go node → store. The control plane receives hashes only. Observers fetch by hash over the CDN.** | The control plane never sees a payload byte. Mandatory under D13's bandwidth caps. |
| D10 | **Per-execution filesystem**, versioned by stage: reads see the filesystem as of stage start plus own writes; writes commit when the result is accepted and become visible next stage; write conflicts within a stage fail the execution; an execution may inherit a prior execution's final root at launch. | Persistence without breaking idempotency or single-assignment. |
| D11 | **Protocol simplifications:** no `ack`; nodes send no hash; a node is a connection (no resume identity; reconnect = new node). | Fewer messages, no stale-identity bugs. |
| D12 | **Determinism is a requirement.** Kernels are WASM with no clock, randomness, or network imports; task inputs exclude anything that differs between twins; planner hints are frozen into the plan task input. | Makes verification meaningful across browsers and machines. |
| D13 | **Hosting = AWS Lambda MicroVMs** (the stateful Firecracker product with per-VM HTTPS endpoints, not Lambda functions). Control plane = one Node process in a MicroVM; store = S3 behind CloudFront; two small Lambda functions vend tokens and manage the fleet. | Endpoint bandwidth is capped by VM size, which is why D9 is mandatory. |
| D14 | **Two cloud cores by default:** two MicroVM workers run whenever the machine is awake, same image as the control plane, role chosen by run-hook payload, no ingress, connecting outward like any node. | Cores are nodes; the control plane cannot tell a tab from a microVM. |
| D15 | **The control plane rotates every hour, even under load.** Several control-plane MicroVMs are in flight during handover; exactly one is active, stamped with a generation. | Deploys reuse the same handover path. |
| D16 | **AWS identity:** a dedicated account; profile **`tabframe`** (an IAM user with AdministratorAccess) is the operator identity for bootstrap and `cdk deploy` only. Every application component runs under a least-privilege role created by CDK. No IAM users or static keys for the application. | Verified 2026-09-01: profile works, region us-west-2, account empty, MicroVMs API reachable, memory quota 8 GB, RunMicrovm rate 1/s. |
| D17 | **Budget:** $100/month notification-only AWS Budget, alerts at 50/80/100 % of actual spend and forecast 100 %. **No automatic kill switch.** The notification address lives in the gitignored `.env.local` and is read at synth time; it is never committed. | The manual kill switch is `mise run down`. |
| D18 | **The control plane's browser-facing surface is WebSocket-only.** Presigned upload URLs are requested as socket messages. Lifecycle hooks and the internal fleet endpoints live on a **private port 8081**; browser tokens are scoped to port 8080. | A fetch carrying the proxy auth header cannot pass a CORS preflight, and hook paths must not be reachable with a browser token. |
| D19 | **Only the machine's default loop continues automatically.** A human-launched execution's follow-up params are recorded and offered as a button, never auto-enqueued; when a human execution ends the machine returns to the default loop. | Nobody's program runs unattended on the project's bill. |
| D20 | **`mise run down` turns the machine off:** disables the rotation schedule, terminates every MicroVM, and writes an *off* state to the pointer that the session function honors with an off page. `mise run up` is the only way back. | Down means down. |

**Small defaults, confirmed:** synchronous file reads through the sandbox glue; `persist` programs inherit the latest finished execution; tile results are RGBA written by the program; **blobs are kept one year**; no operator token — every control is public; heartbeat 1 s, gone at 4 s; frame 1024×640 displayed, 64-px computed tiles; **256 nodes and 64 observers, no per-IP limit**; one public-domain book as the word-count corpus (a Project Gutenberg text with the boilerplate stripped, chosen at build time); **license AGPL-3.0**.

**Cut on purpose:** channels between running tasks and a mutable key-value store (restartability is the whole point); a consensus control plane (single-active generation with snapshots instead); K-way voting beyond the built-in two-way verify and its tie-break; a RISC-V interpreter; a WebRTC peer mesh; intra-tab `SharedArrayBuffer` multicore; server-side C→WASM compilation (in-browser AssemblyScript and bring-your-own-WASM instead).

---

## 2. The system in one page

**Cores** are browser tabs and MicroVMs. Each core runs the same orchestrator, which owns a WebSocket to the control plane and a disposable sandbox that executes program code. Cores come and go constantly; the design treats every departure as ordinary.

**Programs** are WebAssembly modules with two entry points. `plan` turns params and the previous stage's outputs into the next stage's tasks. `run` turns one task's input into bytes. Both execute on cores. A program's only view of the world is a per-execution filesystem of content-addressed blobs. It has no clock, no randomness, no network, and no failure type anywhere in its API.

**The control plane** is a pure function over a small ledger: which nodes exist, which execution is running, which task is in which state and who holds it, and the hash of every accepted result. It assigns, detects death, releases, speculates on stragglers, verifies duplicates, folds stage outputs into filesystem roots, and fans events out to observers. It never touches a payload byte. It runs as one Node process in a Lambda MicroVM, snapshots its ledger to S3 every few seconds, and hands over to a fresh MicroVM every hour.

**The store** is S3 behind CloudFront. Every blob's key is its SHA-256. Nodes upload results, written files, logs, and program modules; observers and nodes read them back by hash. The store computes hashes on upload, so a hash reported to the ledger is one the store vouches for.

**Invariants held everywhere:**

- No shared memory across nodes. Coordination is message passing over sockets; data is blobs by hash.
- Tasks are idempotent and at-least-once. Re-execution is always safe.
- Results are single-assignment and memoized by hash. A done task is never recomputed unless a mismatch invalidates it.
- Location transparency. Nodes are addressed by id; the control plane never learns or cares which tab or VM a node lives in.
- Control plane / data plane split. Metadata and hashes in the ledger; bytes in the store.
- Program code has no error path. The only recovery logic in the system is the control plane's reassignment.
- Determinism. Same input and filesystem, same bytes, on any core.
- Public, verifiable compute only. Nothing is hidden from the host running it.

---

## 3. Runtime picture

```
 One browser tab = one HOST                                  AWS (us-west-2)
 +--------------------------------------------+
 | Host page (main thread)                    |   HTTPS     +------------------------------+
 |  loads html + bundles                      |<----------- | CloudFront                   |
 |  calls session → {endpoint, token, ...}    |             |   /            S3 web assets |
 |  dashboard, controls, editor, queue,       |   GET blob  |   /blob/<hash> S3 blob store |
 |  programs panel, consent banner            |<----------- +------------------------------+
 |  observer socket  <----------------------->|--- WSS ---> +------------------------------+
 |  spawns node workers, relays visibility    |             | Control plane MicroVM (1 GB) |
 |                                            |             |  ledger · scheduler ·        |
 |  +---------------+  +---------------+      |             |  liveness · speculation ·    |
 |  | Node          |  | Node          | ...  |             |  verification · fold ·       |
 |  |  orchestrator |  |  orchestrator |      |             |  fan-out · presign · hooks   |
 |  |  + sandbox    |  |  + sandbox    | <--->|--- WSS ---> |  handover/adopt/drain        |
 |  +---------------+  +---------------+      |             +------------------------------+
 +--------------------------------------------+                    ^            ^
        PUT blob (presigned) --------------------------------------+            |
                                                                                 |
 +------------------------------+   +------------------------------+             |
 | Cloud core MicroVM (0.5 GB)  |   | Cloud core MicroVM (0.5 GB)  | --- WSS ----+
 |  same image, role=core       |   |  same image, role=core       |
 |  no ingress; outbound only   |   |  no ingress; outbound only   |
 +------------------------------+   +------------------------------+

 +------------------------------+   +------------------------------+   +-----------------+
 | Lambda: session (public URL) |   | Lambda: rotate (hourly,      |   | SSM parameter:  |
 |  vend {endpoint, token,      |   |  reserved concurrency 1)     |   | active control  |
 |   storeBase, generation};    |   |  launch → handover → flip →  |   | plane + gen     |
 |  heal when none running      |   |  drain → terminate           |   +-----------------+
 +------------------------------+   +------------------------------+
```

**When a reviewer opens the URL:**

1. **Page load** from CloudFront: the HTML and the bundles (host, node, sandbox, editor).
2. **Session.** The host calls the session function and receives the active control plane's endpoint, a token, the store base URL, and the generation. Tokens are not per client: the session function mints one per control plane every twenty-five minutes and hands the same one to every caller. If the machine is off, the page says so and stops. If the control plane is suspended, its first request auto-resumes it and the page shows the machine waking. If none is running, the session function launches one and the page shows it starting.
3. **Observer socket.** The host connects with the token as a WebSocket subprotocol, subscribes, receives a paged snapshot, fetches finished tiles by hash from the CDN, and paints. From then on it draws each event.
4. **First node.** The host starts one orchestrator worker. It connects on its own socket, says hello, gets a node id, and posts the id back to the host for the "your nodes" panel. The control plane assigns it up to two tasks.
5. **Cores.** The control plane launches its two cloud cores if they are not already running. They fetch a session, connect, and join like any node.
6. **Results.** Each result goes node → store as bytes and node → control plane as hashes. The control plane marks the task done, refills the node, and pushes `taskDone` with the hash to every observer. Every dashboard fetches and paints the same tile within tens of milliseconds.
7. **Heartbeat.** Every orchestrator heartbeats each second on its own socket. The host relays visibility so a hidden tab reports itself throttled.
8. **Controls.** Spawn is local: the host starts more workers. Kill, freeze, throttle, restart, skip, launch, and the redundancy toggle go over the observer socket; the control plane picks victims across the whole cluster, including other people's tabs and the cloud cores, and commands them on their own sockets.
9. **Tab close.** Every worker in the tab dies at once, sockets drop, the control plane marks them gone, and their unfinished work returns to the front of the queue. Nothing is sent on the way out and nothing needs to be.

**Fixed properties:** a node is one orchestrator, one sandbox, one socket; a tab hosts one by default and as many as you spawn. Two socket kinds: observers watch and control, nodes work. `?observe` gives a pure dashboard with no node. In-app spawn is bounded by the visitor's cores; the dashboard shows the core count, defaults spawn to cores minus one, and the rationale says so plainly.

---

## 4. Nodes

A node is one orchestrator plus one sandbox plus one socket. Browser nodes run the orchestrator in a Web Worker and the sandbox in a nested worker. Cloud cores run the same orchestrator under Node with the sandbox on a worker thread. The control plane cannot tell them apart.

### 4.1 Lifecycle

1. **Boot.** The host (or the core's process) hands the orchestrator a session: endpoint, token, store base, generation.
2. **Hello** with protocol version, host id, core count, sandbox version. **Welcome** returns node id, heartbeat interval, in-flight limit, store base, generation. The node never chooses its id; the id is its address.
3. **Heartbeat** every second carrying raw signals only: visible flag, queue length, last task duration, tasks done. Nodes never label themselves fast or slow.
4. **Assign.** Up to two tasks in flight: one running, one queued, so the node never idles waiting for the next assignment.
5. **Compute** in the sandbox (§4.2). Output is deterministic bytes plus buffered file writes and a log.
6. **Upload then report.** The orchestrator asks for presigned URLs over its socket, uploads output, written files, and log to the store, collects the hashes the store vouches for, then sends `result` with hashes only.
7. **Cancel** drops a queued task or aborts a running one at the next opportunity; a result already on the wire is harmless.
8. **Commands:** `close` (the worker ends itself; the socket drops), `freeze` (stop heartbeating and computing, keep the socket open — the zombie the timeout path exists for; terminal), `throttle` (sleep between tasks, a tenth of the speed, heartbeats continue), `resume`.
9. **Death.** Tab closed, host called terminate, or `close` command — all identical to the control plane: the socket drops, nothing is sent first. A frozen zombie is caught by four seconds of silence. Once declared gone, the control plane closes the connection from its side so a zombie never lingers.
10. **Reconnect.** After an unexpected drop the orchestrator fetches a fresh session, reconnects with backoff, and says hello again as a brand-new node. Whatever it had in flight was released when the old node went silent.

### 4.2 Orchestrator and sandbox

**The orchestrator never runs program code.** On assign it ensures the program module is cached (fetch by hash, compile once, keep the compiled module), fetches the stage's filesystem manifest by root hash (cached), posts the compiled module, manifest, input, and limits to the sandbox, starts a deadline timer, and on expiry terminates the sandbox outright and spawns a fresh one — the only clean way to stop a spinning loop.

**The sandbox** instantiates a fresh WASM instance for every task, so no memory state leaks between tasks or programs. It binds the imports (§5.3) to glue closures:

- `stat`, `read`, `list` resolve a path against the stage manifest first and the task's own write buffer second; a resolved hash is fetched from the store with a synchronous request (allowed in dedicated workers; on Node, `Atomics.wait` against the orchestrator thread — both mechanisms verified in preflight on 2026-09-01), with a byte range when asked; a per-node cache by hash makes repeated reads free; unresolvable paths return an error to the program. There is no other network access, and the module cannot name a URL, only a path.
- `write` appends to an in-memory map from path to bytes, enforcing per-task caps on file count and total size; writing a path twice keeps the last.
- `log` appends to a capped buffer.
- A trap or abort ends the task with an error message instead of output.

The sandbox blocks during a synchronous read; heartbeats live in the orchestrator, so that is fine.

**Host ↔ orchestrator** talk only about status over postMessage: `init`, `visibility` inward; `status {nodeId, state: connecting|idle|busy|frozen|throttled|closed, tasksDone, lastTaskMs}` outward. Tasks and results never cross this boundary.

### 4.3 Cloud cores

Same image as the control plane; the run-hook payload selects `role=core` and carries the session URL. A core fetches a session, connects outward to the control plane endpoint on port 8080, and behaves exactly like a browser node. The control plane records each core's MicroVM id in the ledger, so the ids travel with the snapshot and a new control plane inherits its cores at adopt. Cores have no ingress connector, no idle policy, and a four-hour maximum duration as a cost fuse. The active control plane keeps two alive while the machine is awake (§6.8) and replaces one that dies, is killed by a demo control, or nears its ceiling. A cloud core killed by "kill half" reappears a few seconds later: self-healing, visible.

---

## 5. Programs

### 5.1 What a program is

One WebAssembly module exporting `memory`, `alloc`, `run`, and `plan`, plus a manifest:

```json
{ "name": "mandelbrot", "view": "tiles", "persist": false,
  "defaultParams": { "preset": 0 } }
```

A **bundle** is a directory stored as a manifest blob mapping paths to hashes: the module, the manifest, and any inputs under `/in/` (for word count, `/in/corpus.txt`). A program is therefore one hash. Views: `tiles` (planner attaches a placement rectangle to each task; `run` returns RGBA, and an output whose length is not width × height × 4 is a program fault), `bars` (the final result decodes as label/value pairs), `text` (shown raw).

### 5.2 Executions

An **execution** is one run of a program with params. Launch: upload the bundle files → `launch {bundle, params, inherit?}` on the observer socket → the control plane fetches the module, validates imports, exports, size, and declared memory maximum, mints an execution id, and queues it ahead of automatic continuations. When its turn comes, the control plane creates a `plan` task for stage 0. The planner returns a stage spec; the control plane validates it structurally (≤ 4096 tasks, ≤ 1 MB), materializes the tasks, and fills nodes. When a stage's last task lands, it folds outputs and writes into a new filesystem root and creates the next `plan` task. When the planner returns `done`, the execution finishes with its final root recorded. Follow-up params are handled per D19: for the machine's default loop they enqueue an automatic continuation that inherits the root; for a human-launched execution they are recorded and offered on the dashboard as a button. When a human execution ends, the machine returns to the default loop.

**Program faults** — a trap, an over-budget execution, a write conflict, an invalid stage spec — fail the execution visibly with the message. That is the one legitimate error path in the system, and it belongs to the program author, not the runtime.

### 5.3 ABI

```
exports (module provides)
  memory
  alloc(len: i32) -> ptr
  run(inPtr, inLen)  -> ptr to {outPtr: u32, outLen: u32}
  plan(inPtr, inLen) -> ptr to {outPtr: u32, outLen: u32}

imports (module "tf")
  stat(path, pathLen) -> i64                         size, or -1 if absent
  read(path, pathLen, offset, dst, dstLen) -> i32    bytes copied, or negative error
  write(path, pathLen, src, srcLen) -> i32           buffered, replaces the whole file
  list(prefix, prefixLen, dst, dstLen) -> i32        bytes needed; caller retries if larger
  log(src, srcLen)                                   stdout, capped per task

imports (module "env")
  abort(msg, file, line, col)                        AssemblyScript's default; captured, traps
```

**`run` receives** a header {stage, taskIndex, taskCount} followed by the inline input bytes the planner attached — nothing else. No attempt number, node id, or clock: anything that could differ between a task and its twin is kept out.

**`plan` receives** the index of the stage to plan, the launch params, and hints frozen by the control plane when it created the plan task (e.g. connected node count). It reads previous outputs as files under `/out/<stage>/` and returns a stage spec — task inputs with optional placement rectangles and canvas size — or `done {next?}`.

### 5.4 Filesystem

Each execution owns a filesystem: a map from path to blob hash, itself a blob, so the whole thing is one root hash on the execution record, versioned by stage.

- **Reads** see the filesystem as of the start of the task's stage plus the task's own writes.
- **Writes** replace a whole file, are buffered in the sandbox, uploaded by the orchestrator, and become visible to the next stage once the control plane accepts the result. A task that dies wrote nothing.
- **Results are files.** The bytes `run` returns land at `/out/<stage>/<task>` automatically. `/in/` holds the bundle's inputs.
- **Conflicts.** Two tasks in one stage writing different bytes to the same path is a program bug; the execution fails with that message. Identical bytes are fine.
- **Persistence.** At launch an execution starts from its bundle's files, optionally merged with the final filesystem of a named earlier execution; `persist` programs inherit the latest finished execution by default. Everything stays write-once: inheriting is starting from a different root. Blobs are kept one year, everything alike; inheriting a root whose blobs have expired falls back to empty with a visible warning.
- **Result identity for verification** is the hash of the output hash plus the sorted write list, so twins must agree on files as well as output.

### 5.5 Sandbox guarantees, consent, budgets

- Imports allowlist: only the five `tf` calls and `env.abort`. No fetch, clock, randomness, or host calls of any other kind. Validated at upload from the module's import table.
- Fresh instance per task; a declared memory maximum is required and must be ≤ cap (the SDK build sets the compiler flag); module ≤ 8 MB; deadline kill by terminating the sandbox worker; per-task caps on files written and bytes written; per-execution cap on filesystem size; log capped.
- WebAssembly float arithmetic is IEEE with no fusion and no engine math library; AssemblyScript's `Math` compiles to WASM. Deterministic across browsers and machines, with one caveat the SDK documents: NaN payload bits are not guaranteed identical across engines, so kernels must never write NaN into output.
- **Consent:** the page states that an open tab lends CPU to programs other people submitted, sandboxed, with a stop-lending button.
- **Budgets:** per execution a task-count cap and a compute-seconds budget (over budget fails the execution and says so); per program size and memory caps; per observer a launch rate limit.

### 5.6 SDK and demo programs

The AssemblyScript SDK wraps the ABI: `fs.read/readRange/write/list/stat`, `log`, an input decoder, a stage builder `stage(name).task(bytes, place).done(next?)`, and canonical codecs so identical logic yields identical bytes.

**Mandelbrot** is one stage: 640 tasks, each input carrying the full frame parameters and its 64×64 tile; `run` returns RGBA with smooth coloring computed in WASM; `done` returns the next preset, so frames advance while anyone is watching. **Word count** is three stages over `/in/corpus.txt`: map tasks take byte ranges (extended to whitespace on both ends so no word is split or double counted) and emit counts bucketed into eight partitions by a fixed string hash; reduce tasks read every map output under `/out/0/`, slice their partition, and merge; a single merge task reads the eight reduce outputs and emits the global top-K, which is exact because partitions are disjoint. Both compile at build time with the same pinned compiler the in-page editor uses, ship inside the MicroVM image, and are seeded into the store by the control plane on first adopt.

**Submission has two doors:** drop a `.wasm` plus a manifest, or open the in-page editor prefilled with the Mandelbrot source, edit, compile in the browser, and launch. The compiler is AssemblyScript's `asc` bundled for the browser with its Node-only imports stubbed (the package no longer ships a `web.js`), loaded lazily in a worker. Verified in Chromium on 2026-09-01: about seven seconds to load unminified and under half a second to compile, so WP2.4 minifies the bundle and splits binaryen into its own asset. Bring-your-own-WASM keeps the machine honest about being general; in-browser compile keeps the reviewer from needing any local tooling.

---

## 6. The control plane

### 6.1 Shape

A pure function `(ledger, event, now) → (ledger', effects)`. Events: node hello, heartbeat, result, disconnect; observer subscribe, control, ping; clock tick; fleet events. Effects: send, close, launch or terminate a core, upload a manifest. The same core runs in the MicroVM, in a local process, and inside a deterministic test with a fake clock.

### 6.2 Ledger

| Record | Fields |
|---|---|
| Node | id, connection, host id, lastSeen, health, visible, in-flight attempts, rolling compute stats, kind (tab or core) |
| Observer | connection, lastSeen, last acked sequence |
| Execution | id, bundle hash, params, status, queue position, current stage, **filesystem root hash**, budget counters, inheritedFrom, human-launched flag |
| Task | execution, stage, index, kind (`run` or `plan`), input, status (pending, assigned, done, failed), attempts [{node, assignedAt, deadline, outcome}], output hash, **writes [{path, hash, size}]**, log hash, result identity |
| Program | bundle hash, manifest, uploadedAt |
| Meta | generation, epoch, node cap, redundancy toggle, last snapshot time |

Result bytes are never in the ledger. A frame is 640 task records; the whole ledger is a few hundred kilobytes.

### 6.3 Filling a node

Whenever a node has a free slot the control plane draws from three sources in strict priority:

1. **Released tasks** — work that belonged to a node now gone, oldest first, so churn never starves anything.
2. **Pending tasks** in stage order, centre outward for tiles.
3. **Overdue tasks** with one open attempt past its deadline: assigning one here creates a speculative twin.

Speculation is just the lowest-priority source of work; a free slot only reaches it when nothing else is left, which is exactly the end of a stage where stragglers hurt. Health never gates assignment; the deadline is the safety net.

### 6.4 Liveness, deadlines, health

Any inbound node message refreshes lastSeen. Gone after four seconds of silence or immediately on socket close. Going gone releases every open attempt the node had (a task with a live twin stays with the twin), closes the connection server-side, and emits `nodeLeft` plus one `taskReassigned` per released task. Observers ping every two seconds; the pong carries the current sequence number.

Each attempt's deadline is assignedAt plus three times the rolling median compute time, floored at about two seconds. A task never has more than two open attempts.

Health labels are computed by the control plane: fast or slow against the cluster median; throttled when the host tab reports itself hidden; gone on silence. A change emits `nodeHealth`.

### 6.5 Results and verification

A result names hashes the store vouches for. If the task is not done: it becomes done with that result identity, the node is refilled, `taskDone` goes to observers, and a running twin gets `cancel`. If the task is already done: identities are compared; a match counts as a verified duplicate (the live proof that recompute yields identical bytes); a mismatch follows D7. A result is valid for its task whatever attempt produced it, so a thawed node's late result is accepted if the task is still open and verified if not.

With the redundancy toggle on, every new task opens two attempts from the start and a tile is painted only when they agree. A trap is a result carrying an error; two agreeing traps fail the task and the execution.

### 6.6 Stage advance

When a stage's last task completes: fold every task's outputs (`/out/<stage>/<i>`) and writes into a new filesystem manifest (rejecting the stage on a path conflict), upload the manifest blob, set the execution's root, create a `plan` task for the next stage with frozen hints, and fill. The planner's output is validated and materialized; `done` finishes the execution and may enqueue a continuation.

### 6.7 Queue, observers, controls

One execution runs at a time. Human-launched executions go ahead of automatic continuations, so a submission starts within seconds while the current frame is abandoned.

Observers subscribe and receive a paged snapshot, then sequence-numbered events; a gap triggers a resubscribe. Throughput is computed on the dashboard from `taskDone` timestamps.

Controls: `killHalf`, `freezeHalf`, `throttleHalf` pick half the live nodes at random across the whole cluster — including cloud cores — and command them, then emit `controlApplied` naming the victims; `resumeAll`; `restart` (abandon the current execution, enqueue a fresh one of the same program at the front); `skip` (end the current execution, start the next); `killExecution {id}`; `launch`; `setRedundancy`; `ping`. Spawn is not a message: only the host page can create a thread in its own tab. Controls are rate limited per observer; the caps — 256 nodes, 64 observers, no per-IP limit — are enforced at hello and subscribe.

### 6.8 Fleet policy and sleep

The active control plane keeps **two cloud cores** alive while the machine is awake: while any observer is connected or a human-launched execution is running. It launches them a second apart (the account's RunMicrovm rate is one per second) with backoff on throttling, replaces one that dies or nears its four-hour ceiling, and records their MicroVM ids in the ledger so they survive a handover; listing by tag is only a reconciliation fallback.

After **ten minutes without an observer**, or **sixty minutes without any human interaction even with a dashboard open** (a tab left open overnight), it terminates the cores and pauses automatic continuation, and the dashboard says so with a click-to-resume. With no traffic left, the control plane's idle policy suspends it after fifteen minutes; the first visitor wakes everything.

### 6.9 Generation

Every control plane is stamped with a generation. It appears on welcome, snapshot, and every message; a control plane rejects messages from another generation. Exactly one generation is active at any time (§9.4).

### 6.10 Invariants (each one a test)

- A task is done at most once; the first accepted result is final unless a mismatch invalidates it.
- Nothing is ever assigned to a node that is gone.
- Every task completes as long as one live node exists.
- At most two open attempts per task.
- Released work outranks fresh work.
- No correctness depends on a message from a dying node — or from a dying control plane.

---

## 7. Data paths and the store

### 7.1 Store API

```
GET  /blob/<hash>                 via CloudFront: immutable, cache-forever, Range supported
presign {hash,size}[]             a socket message (node or observer socket) → presigned PUT URLs
                                  for keys equal to the hashes, SHA-256 checksum pinned
PUT  <presigned url>              straight to S3; S3 rejects bytes that don't hash to the key
```

Presign over the socket is the only write path (D18). Because S3 verifies the pinned checksum, a hash the node reports is a hash the store vouches for; the node did not choose it. Locally, the dev server's presign returns URLs to itself and hashes on receipt. One client flow everywhere.

Three infrastructure details make this work from a browser: the blob bucket's CORS allows PUT with the checksum header from the page's origin; the immutable cache-control header is part of the signed request; and the CloudFront blob behavior has an error-caching TTL of zero, so a request that lands a moment before an upload completes does not pin a 404 for five minutes. Observers retry a 404 with backoff.

### 7.2 Read path (during `run`)

Program calls `read` → glue resolves the path to a hash through the stage manifest (or the task's own buffer) → bytes come from the node cache or a synchronous GET by hash over the CDN → copied into module memory. The control plane is not involved.

### 7.3 Write path

1. Program calls `write`; the glue buffers it.
2. `run` returns; the sandbox posts output, writes, and log to the orchestrator.
3. The orchestrator requests presigns for all hashes at once over its socket, PUTs in parallel straight to S3, and collects the confirmations.
4. `result` is sent with hashes only.
5. The control plane accepts under §6.5 and records the write list on the task; the writes are still invisible.
6. The stage completes; the control plane folds outputs and writes into a new manifest, rejects on conflict, uploads it, and sets the root.
7. The next stage's assigns carry the new root.

### 7.4 Who touches bytes

Nodes read and write payloads. Observers read them. The launcher writes bundles. The control plane reads stage specs and writes filesystem manifests — small metadata — and never a payload byte. Under the MicroVM endpoint's bandwidth cap this is not a nicety; it is what makes the control plane fit in a 1 GB VM at 2 MB/s.

### 7.5 Late joiners and gaps

A new observer's snapshot is the task table, paged; it fetches finished tiles by hash, and the tenth observer costs S3 nothing because the CDN has them. Any observer that sees a gap in event sequence numbers resubscribes. Nothing depends on a push arriving.

---

## 8. The wire

### 8.1 Channels and encoding

| Channel | Carries | Transport |
|---|---|---|
| Node socket | hello, heartbeat, assign, result, cancel, command | WebSocket, JSON text frames |
| Observer socket | subscribe, snapshot, events, controls, ping | WebSocket, JSON text frames |
| Store | blobs by hash | HTTPS GET via CloudFront; presigned PUT straight to S3; presign requests ride the sockets |
| Session | `{endpoint, token, expiresAt, storeBase, generation}` or `{off: true}` | HTTPS GET to the session function |
| Internal | handover, adopt, drain, health, diag | HTTPS on the control plane's private port 8081, fleet token plus fleet secret |

Every socket message is one JSON text frame with a type field and the generation. Bytes never ride a socket except a task's inline input (base64, ≤ 16 KB); everything else is a hash. Every message is under 64 KB; snapshots are paged. Zod schemas in the protocol package are the single source of truth; both ends validate every inbound message, and an invalid one closes the connection with a reason code.

### 8.2 Node socket

| Direction | Message | Fields |
|---|---|---|
| node → cp | hello | protocol version, host id, cores, sandbox version, kind |
| cp → node | welcome | node id, heartbeat ms, max in flight, store base, generation |
| node → cp | heartbeat | visible, queue length, last task ms, tasks done |
| cp → node | assign | task id, attempt, execution id, program hash, kind, stage, index, count, input, fs root, deadline ms, limits |
| node → cp | result | task id, attempt, output hash, writes, log hash or inline log, compute ms — or error text and log |
| node → cp | presign | list of {hash, size} |
| cp → node | presigned | list of {hash, url, headers} |
| cp → node | cancel | task id |
| cp → node | command | close, freeze, throttle, resume |

### 8.3 Observer socket

**Subscribe** carries the protocol version and optionally the last sequence number seen. **Snapshot** pages carry nodes with health, the queue, the current execution with stage and root, every task's status, holder, output hash and placement, the counters, and the current sequence number.

**Events:** nodes — `nodeJoined`, `nodeLeft`, `nodeHealth`; executions — `executionQueued`, `executionStarted`, `stageStarted`, `stageDone`, `executionDone` (carrying follow-up params when the program offered any), `executionFailed`, `budget`; tasks — `taskAssigned`, `taskDone`, `taskReassigned`, `taskSpeculated`, `taskVerified`, `taskMismatch`, `taskFailed`; system — `controlApplied`, `programAdded`, `controlPlaneRotating {gen, next}`, `machineSleeping`, `error`.

**Controls:** `killHalf`, `freezeHalf`, `throttleHalf`, `resumeAll`, `restart`, `skip`, `killExecution`, `launch`, `runFollowUp`, `setRedundancy`, `presign` (for bundle uploads), `ping`.

### 8.4 Sizes, limits, codes

| Message | Typical | Cap |
|---|---|---|
| heartbeat | 150 B | 1 KB |
| assign | 600 B + input | 16 KB inline input |
| result | 200 B + writes | 256 written files |
| snapshot page | 40 KB | 256 tasks per page |
| event | < 1 KB | 4 KB |
| stage spec | a blob | 1 MB, 4096 tasks |
| module | a blob | 8 MB |

Reconnect with exponential backoff and jitter, 0.5 s to 30 s; a reconnecting node is a new node; a reconnecting observer resubscribes; tokens are refreshed before expiry. **Rotation jitter:** the rotating-reconnect close carries a delay the control plane drew uniformly from a window sized to its client count — 30 ms per connected client, at least 2 s — and each client waits that long before fetching a session. A rotation with 300 clients would spread its session calls and socket upgrades over roughly 9 s, about 33 per second, under the endpoint's measured limit of about 50 requests per second and well under the account's Lambda concurrency (now 1000; it was 10 when this was written). In practice one control plane never has 300 clients: a MicroVM endpoint holds **16 concurrent connections** (§9.7), so the window is rarely above its two-second floor. Protocol version mismatch closes with a dedicated code and the page reloads itself once. Rate limits: roughly twenty messages a second per node, five per observer; one launch a minute and one control a second per observer. Caps in the ledger: 256 nodes, 64 observers, no per-IP limit — but the ledger's caps are not the binding ones; the endpoint's 16 concurrent connections per MicroVM are (§9.7). **Close codes:** invalid message, version mismatch, node cap, rate limited, declared gone, rotating-reconnect-now.

**Deliberately not carried:** payload bytes, acks, resume tokens, client timestamps, or anything a node could use to learn where another node lives.

---

## 9. Hosting and fleet

### 9.1 Platform facts that shape the design

| Fact (Lambda MicroVMs) | Consequence |
|---|---|
| Image built from a Dockerfile; app started; snapshot taken; every MicroVM boots from it | The control plane is a Node process that boots already listening |
| Dedicated TLS endpoint per MicroVM; HTTP/1.1, HTTP/2, WebSockets, SSE; port 8080 by default | No load balancer, no certificate |
| Every request needs a JWE token (1–60 min), minted with AWS credentials; browsers pass it as a WebSocket subprotocol or a fetch header | A token-vending front door |
| Hard maximum 8 hours, running plus suspended | Hourly handover (D15) |
| Idle policy suspends on no endpoint traffic; auto-resume holds the first request; hooks on run, suspend, resume, terminate | Idle costs nothing; heartbeats and pings keep it awake while anyone is connected |
| Endpoint bandwidth capped by size: 1 MB/s at 0.5 GB, 2 MB/s at 1 GB | D9 mandatory |
| Public egress by default; ARM64; us-west-2 available | Presign from the execution role; build for arm64 |
| CloudFormation/CDK define images; running MicroVMs are API-managed | CDK owns image, roles, buckets, front door; the fleet function starts instances |
| Account quotas read 2026-09-01: 8 GB MicroVM memory, RunMicrovm 1/s, 8 h max | 2–3 GB baseline in use; space launches; back off |

### 9.2 Topology

- **Fleet functions** (two Lambdas sharing code): `session` on a public URL vends sessions — one shared token per control plane, minted every twenty-five minutes and cached — and triggers a heal when no control plane runs, or serves the off state; `rotate` runs hourly on EventBridge with reserved concurrency 1, is idempotent (it checks the pointer and the running MicroVMs before launching anything), and is the sole writer of the pointer.
- **Pointer:** one SSM parameter naming the active control-plane MicroVM and its generation.
- **Control plane:** 1 GB (the API takes only a minimum memory; the vCPU class is the platform's, and for every size we can launch it is the 2-vCPU class, §9.7), `ALL_INGRESS` + `INTERNET_EGRESS`, idle policy suspend after 15 min with auto-resume, max duration 8 h. Public port 8080 carries sockets only; private port 8081 carries hooks and the internal endpoints; browser tokens are scoped to 8080, fleet tokens to all ports.
- **Cloud cores:** two × 0.5 GB, `NO_INGRESS`, no idle policy, max duration 4 h.
- **Store and static:** S3 behind one CloudFront distribution.

### 9.3 One image, two roles

Control plane and core are the same MicroVM image (§11.3). The process boots **neutral**: listening on both ports, answering hooks, holding no role and making no AWS calls. `/ready` returns 200 once listening; `/validate` runs a short in-process hello → assign → result cycle against an in-memory store, which both proves the image and lets Lambda prefetch the parts of the snapshot that matter. `/run` delivers the payload that turns the neutral process into a control plane or a core: role, generation, snapshot key, session URL, store base, fleet secret. Nothing fleet-related is baked into the image, which keeps the CDK stacks acyclic: Core → Image → Fleet.

### 9.4 Authority and handover

Exactly one control plane is **active**, stamped with a generation. Others are booting or draining. "In flight" never means "authoritative."

**Hourly handover — also the deploy path:**

1. `rotate` launches CP(g+1) with a payload naming the generation and the latest snapshot key, and waits for its run hook.
2. `rotate` calls CP(g) `/handover`: it stops assigning, pauses intake, serializes the ledger, and returns it.
3. `rotate` posts the ledger to CP(g+1) `/adopt`: it marks every node gone (releasing their work), becomes active.
4. `rotate` flips the pointer.
5. `rotate` calls CP(g) `/drain`: it closes every client with the *rotating, reconnect now* code and a jittered reconnect delay (§8.4), and is terminated after a grace period.
6. Clients fetch a fresh session and reconnect. Nodes rejoin as new nodes; cores likewise. A few seconds of churn per hour, under load.

**Failure paths:** CP(g) unreachable → adopt from the latest S3 snapshot (≤ 5 s stale; idempotency makes it safe). `rotate` dies mid-way → the next run inspects both MicroVMs and finishes or rolls back. Session function sees no running control plane → invokes `rotate` to heal; nothing runs until the first visitor arrives.

**Snapshots:** the control plane writes its ledger to S3 every 5 s when it has changed, gzipped, and in the suspend and terminate hooks, keyed by generation and time, kept one day. Core MicroVM ids are part of the ledger, so cores follow the snapshot through a handover.

**Off:** `mise run down` disables the hourly schedule, terminates every MicroVM, and writes *off* to the pointer. The session function returns `{off: true}` and heals nothing; the page shows an off screen. `mise run up` clears the state and launches a control plane.

### 9.7 Capacity: what one MicroVM endpoint can hold

Measured on 2026-09-02 (`docs/m3-verification.md`, `packages/infra/scripts/socket-ceiling.ts`) and
confirmed in the account's Service Quotas: a MicroVM endpoint accepts **16 concurrent connections**
and answers 429 to the seventeenth. The quota is *Concurrent connections per 2 vCPU MicroVM*, it is
not adjustable, and it scales only with the vCPU class (8 / 16 / 32 / 64 / 128 for 1 / 2 / 4 / 8 /
16 vCPU). The class cannot be chosen: `RunMicrovm` takes a minimum memory and nothing else, and every
size we launched — 512 MiB to 6 GB — behaved as the 2-vCPU class. The ceiling is per MicroVM, not per
token, client process, or source: three tokens, three processes, and a 6 GB VM all stopped at 16.
Open WebSockets count against it, so a control plane with 16 clients cannot even be reached by the
fleet on its private port — which is why `/handover` falls back to the snapshot (§9.4).

Consequences: one control plane serves at most about fifteen browser tabs plus the fleet's own
calls; the "256 nodes" cap in the ledger is a property of the scheduler, not of the deployment; and
"thousands of concurrent clients" cannot be reached through a MicroVM endpoint at any size. Reaching
them needs an edge that terminates client connections somewhere else and speaks to the control plane
over a few connections — an API Gateway WebSocket API (`PostToConnection` for pushes, a Lambda
integration for inbound), IoT Core, or a relay tier of MicroVMs (each relay is itself capped at 16
clients, so a relay tier caps out around 240 before the control plane's own budget is spent). The
protocol survives any of them unchanged: the core already speaks to connections through a `Transport`
seam. **Decided 2026-09-02 (Mircea):** document the ceiling for now and scope the demo to it; after
M5, evaluate hosting the control plane on an **EC2 instance** instead of a MicroVM — no per-VM
connection quota, thousands of sockets on one host, the same process and protocol — at the cost of
the MicroVM story (snapshot boot, hooks, suspend/resume) and a different rotation mechanism. The
plan's WP4.6 keeps the alternatives.

### 9.5 Costs

| Scenario | Cost |
|---|---|
| Idle, suspended, 1 GB baseline | ≈ $0.08/month of snapshot storage |
| One reviewer hour, cores mostly idle | ≈ $0.13 |
| One reviewer hour, cores computing flat out (bursting to a full vCPU each) | ≈ $0.26 |
| Left running all day | ≈ $3 |
| Each suspend/resume cycle | < $0.01 |

### 9.6 Verified in M0

Measured on 2026-09-02 against the deployed image (`docs/m0-verification.md`): WebSocket frames count as idle-policy traffic; an open socket survives its token's expiry; the endpoint throttles at about 50 requests per second, so reconnect jitter is 30 ms per client (§8.4); 250 concurrent sockets are sustained when opened at a paced rate; 15 messages per second per connection passes; DNS and S3 resolve inside the image; boot to RUNNING takes about 2 s and resume under 1 s at 1 GB; token minting is not throttled at 20 in a burst; the memory quota is 8 GB and RunMicrovm is limited to 1 per second. No fallback was needed.

---

## 10. Security and credentials

### 10.1 Identity model

- **Account:** a dedicated AWS account for this project alone.
- **Operator identity:** profile `tabframe`, an IAM user with AdministratorAccess, used only for `cdk bootstrap` and `cdk deploy`. Every AWS call from the laptop uses this profile; nothing in AWS runs as it. `AWS_PROFILE` is set by mise, `--profile` is passed explicitly on ad-hoc calls, and a `whoami` guard task asserts the account id (kept in the gitignored `.env.local`) before any AWS-touching task runs. There is no fallback to any other profile.
- **Application roles**, all created by CDK with least privilege:

| Role | Trusted by | Can |
|---|---|---|
| Image build | MicroVM image builder | read the artifact bucket, write build logs |
| Control-plane execution | MicroVM runtime | put to the blob bucket (presigning), read/write the snapshot bucket, read the pointer, run/get/list/terminate MicroVMs tagged as cores, pass the core role, write logs |
| Core execution | MicroVM runtime | write logs — nothing else |
| Session function | Lambda | mint endpoint tokens, get one MicroVM, read the pointer, invoke `rotate` |
| Rotate function | Lambda | run/get/list/terminate control planes, mint tokens for handover calls, read/write the pointer, pass the control-plane role, read snapshots |
| CDK roles | CDK bootstrap | conventional; the CloudFormation execution role stays administrator so deploys can create the roles above |

Build and execution roles trust `lambda.amazonaws.com` for `sts:AssumeRole` and `sts:TagSession`, per the MicroVMs security guide; the control-plane and fleet roles get the `lambda:*Microvm*` actions plus `iam:PassRole` for the roles they launch with. No IAM users or static keys for the application. S3 buckets are private behind CloudFront. The browser never holds AWS credentials: it gets a JWE token scoped to one MicroVM and port 8080 only, shared by every visitor and refreshed every twenty-five minutes, and presigned S3 URLs scoped to one key with a pinned checksum and a short expiry. Privileged paths — hooks, handover, adopt, drain, health, diag — live on port 8081, which browser tokens cannot reach, and additionally require the fleet secret from the run payload.

### 10.2 Hygiene rules

- **Repo:** no keys, no account id, no email addresses, no CDK context that embeds the account. `.env.local` is gitignored and holds the profile override, the expected account id, and the budget address.
- **Transcripts** are a deliverable, so no secret, token, presigned URL, or account id may appear in them. Commands whose output could include one write raw output to a scratch file; only a masked summary reaches the conversation.
- **Hard stops only:** destructive or irreversible actions (deleting stacks, buckets, or data; rewriting pushed history; `mise run down`), spending outside the agreed design or budget, and contradicting a decision Mircea explicitly owns. Everything agreed in this record and the plan — bootstrap, the budget deploy, enabling the schedule — proceeds without asking.
- **Budget:** $100/month, notification-only, alerts at 50/80/100 % actual and forecast 100 %, no automatic kill switch; address from `.env.local` (`TABFRAME_BUDGET_EMAIL`), never committed. Manual kill switch: `mise run down`, which turns the machine off until `mise run up` (D20).

---

## 11. Tooling and repo

### 11.1 Runtimes

Node 22 everywhere in production: the MicroVM image, the fleet Lambdas, CDK. Node 22 runs `.ts` files directly, so the control plane needs no build step locally. Bun is the developer toolchain: workspaces, `bun test`, browser bundles. Nothing at runtime depends on Bun. One coding rule follows: Node strips only erasable TypeScript syntax, so no enums, namespaces, or parameter properties, enforced with `erasableSyntaxOnly` in the base tsconfig. Unit tests run under Bun; process-level tests spawn Node so the runtime under test is the production one. Verified 2026-09-01: Node 22.23 imports `.ts` across workspace packages through `exports` entries that point at sources.

### 11.2 mise.toml

```toml
[tools]
node = "22"
bun = "1.3"
aws-cli = "latest"
gh = "latest"
"npm:aws-cdk" = "latest"

[env]
AWS_PROFILE = "tabframe"
AWS_REGION = "us-west-2"
_.file = ".env.local"        # gitignored: TABFRAME_ACCOUNT_ID, TABFRAME_BUDGET_EMAIL

[tasks.install]  run = ["bun install", "bunx playwright install chromium"]
[tasks.whoami]   run = "node packages/infra/scripts/whoami.ts"        # asserts account id; every AWS task depends on it
[tasks.lint]     run = "bunx biome check ."
[tasks.dev]      run = "node packages/dev/src/up.ts"
[tasks."dev:rotate"] run = "node packages/dev/src/rotate.ts"          # second control plane + local handover
[tasks.test]     depends = ["lint"]; run = ["bun test", "bunx playwright test"]
[tasks.sim]      run = "node packages/core/sim/run.ts"                 # --seed N, --long
[tasks.goldens]  run = "node packages/sdk-as/scripts/goldens.ts"
[tasks.build]    depends = ["build:programs", "build:web", "build:image"]
[tasks."build:programs"] run = "node packages/sdk-as/scripts/build-programs.ts"
[tasks."build:web"]      run = "bun build packages/web/src/{host,node,sandbox,editor}.ts --target=browser --outdir packages/web/dist"
[tasks."build:image"]    run = "bun build packages/control-plane/src/main.ts --target=node --outfile packages/control-plane/dist/main.js"
[tasks.deploy]   depends = ["whoami", "build", "test"]; run = ["cdk deploy --all", "node packages/fleet/scripts/rotate.ts"]
[tasks.verify]   depends = ["whoami"]; run = "node packages/infra/scripts/verify-m0.ts"
[tasks.up]       depends = ["whoami"]; run = "node packages/fleet/scripts/up.ts"      # clears off, launches a control plane
[tasks.down]     depends = ["whoami"]; run = "node packages/fleet/scripts/down.ts"    # off: disable schedule, terminate all, write off"
[tasks.logs]     depends = ["whoami"]; run = "aws logs tail /aws/lambda/microvms/tabframe --follow"
```

AssemblyScript is a workspace devDependency, not a mise tool, so the build-time and in-browser compilers are the same pinned version.

### 11.3 Layout and image

```
tabframe/
  mise.toml  package.json  tsconfig.base.json  biome.json  .env.local (gitignored)
  packages/
    protocol/        zod schemas + types for every message, close codes, generation, limits; canonical codecs
    core/            pure control-plane logic and the churn simulation harness; Store/Transport/Clock interfaces
    control-plane/   the process: http + ws, lifecycle hooks, handover/adopt/drain, presign, S3 snapshotter,
                     core fleet manager, seeding, local store route; Dockerfile
    sandbox/         WASM glue: ABI, the five imports, FS manifest resolution, caps;
                     adapters: web worker (sync XHR) and node worker_thread (Atomics.wait)
    node/            the orchestrator; entry points platform/web.ts and platform/node.ts
    web/             host page, dashboard, controls, editor, programs panel, queue, banners
    sdk-as/          AssemblyScript SDK, program build and goldens scripts
    fleet/           the two Lambdas: session and rotate; shared MicroVM client and SSM pointer; rotate/down scripts
    infra/           CDK app, image publish, whoami and verify scripts
    dev/             the one-command local topology
  programs/
    mandelbrot/      assembly/index.ts, manifest.json, goldens.json
    wordcount/       assembly/index.ts, manifest.json, in/corpus.txt, goldens.json
  docs/              this record, architecture notes, rationale, transcripts
```

```dockerfile
FROM public.ecr.aws/lambda/microvms:al2023-minimal
RUN dnf install -y nodejs22 && dnf clean all
COPY packages/control-plane/dist/main.js /app/main.js
COPY programs/*/dist/ /app/programs/
EXPOSE 8080
CMD ["node", "/app/main.js"]
```

Lambda builds the image on ARM64 itself; Docker is optional locally. Bundling to one file keeps the snapshot small, which is what resume latency is made of.

### 11.4 CDK

Three stacks in dependency order — **Core** (buckets for artifacts, blobs, snapshots, and web, with a one-year lifecycle on blobs; one CloudFront distribution with two origins and an error-caching TTL of zero on the blob behavior; blob-bucket CORS allowing PUT with the checksum header from the page's origin; the SSM pointer with its off state; the budget), **Image** (`CfnMicrovmImage` with the base image version looked up by a script, hooks on port 8081, an environment holding only bucket names and the pointer name, and the build, control-plane, and core roles), **Fleet** (session with a public function URL, CORS for GET from the page's origin, and a modest reserved concurrency; rotate on an hourly EventBridge rule created disabled until M3, reserved concurrency 1; their roles). Outputs feed the web config (the session URL only) at deploy. Image publishing goes through CloudFormation so the operator needs no extra rights.

### 11.5 Repo policy

Created by Mircea at `github.com/t3spe/tabframe`; **private until the end, then public.** License **AGPL-3.0**. Commits under the existing GitHub noreply identity. Contents: code plus `docs/` (this record, the plan, the time log, architecture, rationale, and transcripts — export mechanism to be decided later). The seed and handoff documents stay out. Biome for lint and format. **Git flow:** a branch per work package, merged into `main` with a `--no-ff` merge commit once lint and tests are green, then deleted; no direct commits to `main`; history never rewritten; **and CI on `main` must be green before the next work package starts** — local green is not a substitute, because CI runs on a fresh checkout with nothing built. **Every work package ships a document** at `docs/implementation/wp-<m>.<n>-<slug>.md` — what was done, how, why, evidence, drift, open items — so the implementation history is readable without the commits.

---

## 12. Tests and dev loop

**`mise run dev`** brings up the machine on a laptop: the control plane under `node --watch` in local mode (in-memory ledger, local store route with hash-verifying PUT, self-presign, emulated session endpoint, hooks as routes; public and private ports default to 4080 and 4081 locally because 8080 is taken on the development machine, while the image uses 8080 and 8081), **two local cores** as Node processes on the node platform entry, the web bundles in Bun watch mode, and seeding. **`mise run dev:rotate`** starts a second control plane and drives the real rotate code with a local driver — handover on a laptop before it touches AWS.

| Layer | Proves | Runner |
|---|---|---|
| Protocol | schemas round-trip; invalid, oversized, and foreign-generation messages are rejected | bun test |
| Core, pure | fill priority, liveness, deadlines, health, both verification policies, fold and conflict detection, queue ordering, snapshot round-trip, adopt marks nodes gone, fleet policy, sleep policy | bun test |
| **Churn simulation** | correctness under arbitrary churn: seeded generator, virtual clock, fake store, real WASM programs under Node; invariants asserted after every event; final hashes equal goldens from single-node runs; lying-node and redundancy-on scenarios; replay by seed | bun test, seed matrix |
| Sandbox | forbidden imports and missing exports rejected, memory cap, deadline kill of an infinite loop, write caps, unresolvable paths, traps captured, no state leak, determinism | bun test (Node adapter), Playwright (web adapter) |
| Programs | compile; tile hashes match goldens; word count matches a JavaScript reference; plan outputs validate | bun test |
| Control-plane process | real sockets against a spawned process: hello → result, presign → PUT → hash check, role from payload, snapshot on suspend, handover between two processes, drain code | bun test |
| Fleet | rotate and session against a fake MicroVM client, including old-unreachable and crash-mid-rotation | bun test |
| **Browser end to end** | the money shot: spawn 10, kill half, canvas hash equals golden; editor compile and launch; local rotation mid-render | Playwright |
| Infra | stack synthesizes; `cdk diff` before every deploy | bun test |

Plumbing: the core takes an injected clock and random source; `mise run goldens` regenerates goldens from single-node runs and any kernel change updates them in the same commit; sandbox fixtures are tiny AssemblyScript sources compiled at test time by the pinned compiler. Coverage: `bun test --coverage` with an 85 % line threshold in `bunfig.toml` for protocol, core, sandbox, control-plane, and fleet, report-only for web; property-based tests with fast-check on ledger transitions; the simulation's long mode runs nightly. A minimal GitHub Actions workflow on the private repo runs install, lint, and both suites; **no AWS credentials in CI**; deploys are manual; `mise run verify` is the M0 runbook, not a test.

---

## 13. Deploy, operations, and the reviewer's view

**M0 = skeleton + verification.** Buckets, CloudFront, fleet functions, pointer, and an image whose control plane only does hello and heartbeat. Order: `mise run whoami`, `cdk bootstrap` (with confirmation), deploy, publish image, `rotate`, hit the session URL, open a socket, then `mise run verify` retires §9.6 and records results and any design adjustments in `docs/m0-verification.md`.

**Deploy = rotation.** build → test → `cdk deploy` (stack, image version, web assets) → wait for the version to go active → `rotate`. Cores move to the new version over the next cycle. Hashed asset names with a short TTL on the index; a protocol bump reloads stale pages once. **Rollback** = rotate to the previous immutable image version and deactivate the bad one.

**Observability:** MicroVM logs in CloudWatch, fleet logs, `/health` and `/diag` on the control plane, and the dashboard's generation, uptime, and next-rotation countdown.

**Cost guards:** idle policy; no cores and no continuation without an observer; the sixty-minute no-interaction pause; no automatic continuation for human-launched programs; maximum durations on every MicroVM; the node cap; the $100 budget; `mise run down`, which keeps the machine off until `mise run up`.

**The reviewer's first minute.** Page from CloudFront → session → a suspended control plane resumes ("waking") or none exists and one is launched ("starting") → the tab's node joins → two cores arrive → three nodes rendering in under about thirty seconds. Warm path: instant.

**Demo script, about five minutes.** One tab plus two cloud cores rendering → two more real tabs → spawn ten (bounded by cores, said on screen) → kill half → freeze half → throttle half (twins, verified duplicates) → redundancy on → editor: change the palette, compile in the browser, launch → word count: three stages and a bar chart → trigger a rotation: banner, reconnects, render continues → ledger and files panels: hashes everywhere, no bytes in the control plane.

**Packaging.** README (what, why, architecture, in and out of scope, run, deploy); the rationale doc answering the five required questions, with time spent taken from `docs/timelog.md`, which keeps two columns — developer time and total time — and states the developer number with the total alongside; the video; transcripts (mechanism decided later); secrets scan; the AGPL-3.0 license file; corpus attribution; then public.

---

## 14. Milestones

Fault-tolerant order; each leaves something deployable.

| M | Contents | Checkpoint |
|---|---|---|
| M0 | repo skeleton, mise, workspace, protocol and core skeletons, local dev up with hello/heartbeat; CDK skeleton, hello-only image, session URL; `mise run verify` | a public URL answers; the six unknowns are retired |
| M1 | ledger, fill, liveness, deadlines, verification, churn simulation; browser node, sandbox, Mandelbrot as a program; basic dashboard; local cores | kill half on a laptop, image completes, hashes match |
| M2 | planning as a task, filesystem, word count, editor and in-browser compile, queue, views | a reviewer's edited program runs on the cluster |
| M3 | snapshots, handover and hourly rotation, cloud cores, sleep policy, deploy as rotation, fleet functions | rotation under load on AWS, render continues |
| M4 | observability polish, banners, ledger and files panels, Playwright end to end | the demo script runs unattended |
| M5 | README, rationale, video, transcripts, secrets scan, public | submitted |

---

## 15. Rationale hooks

- Nodes are a bare machine: the bundle contains no application code; programs arrive as bytes by hash, and the same bytes run in a tab and in a Firecracker VM.
- Failure is a non-event because tasks are idempotent, results are memoized by hash, and the program ABI has no failure type.
- The control plane is metadata only; bytes live in a content-addressed store; hashes bridge the two — the seed's constraint two, done literally, and forced by a bandwidth cap.
- Planning runs on the cores; the control plane never executes user code.
- Even the control plane is churn: it rotates hourly, and the ledger outlives it. Deploys are rotations.
- Verification is live and honest: the mismatch counter should read zero forever, and the redundancy toggle proves recompute yields identical bytes across browsers and VMs.
- Files are single-assignment per stage, which is why persistence does not break re-execution.
- Cut on purpose: channels between running tasks and a mutable KV — restartability is the whole point.
- **Time and scope, said plainly:** the assignment grades scoping against an eight-hour ceiling and asks for time spent. This build is many days by deliberate choice, and the rationale must state the number and own the choice rather than round it down.

---

## 16. Glossary

**Host** — a browser tab: one observer socket plus zero or more nodes. **Node / core** — one orchestrator, one sandbox, one socket; a tab worker or a MicroVM. **Observer** — a dashboard connection. **Program** — a WASM module with `plan` and `run` plus a manifest. **Bundle** — a program's directory as a manifest blob. **Execution** — one run of a program with params. **Stage** — a set of tasks that may run in any order. **Task** — one kernel invocation; **attempt** — one assignment of a task to a node; **twin** — a second open attempt. **Root** — the hash of an execution's filesystem manifest at a stage boundary. **Generation** — the stamp of one control-plane instance; exactly one is active. **Store** — the content-addressed blob store. **Pointer** — the SSM parameter naming the active control plane.

## 17. Drift log

Dated deviations discovered while building, recorded before the code landed (plan §0).

- **2026-09-02 (WP0.10).** The account's Lambda concurrency default of 10 must stay fully
  unreserved, so the fleet functions run without reserved concurrency; rotate stays single-writer by
  idempotency and a per-generation client token (§9.2). `NodejsFunction` bundles the AWS SDK
  because the runtime's copy predates MicroVMs. `iam:PassRole` grants carry no `PassedToService`
  condition, and `lambda:PassNetworkConnector` is granted on `*` (§10.1). The session function's
  URL has no CORS configuration of its own; the handler answers it (§9.2). The store base handed to
  clients is `https://<distribution>/blob` (§7.1). A fourth stack, **Web**, deploys the page and
  `config.json`; the order is Core → Image → Fleet → Web (§11.4). The image staging directory is
  generated by `build:image` and selected with `TABFRAME_IMAGE_DIR`; the image environment sets
  `TABFRAME_MODE=image` and `TABFRAME_HOST=0.0.0.0` (§9.3, §11.3). `mise run deploy` ends with
  `up`, which is idempotent for a running control plane (§13).
- **2026-09-02 (WP1.6).** A node that reaches its own deadline (the control plane's deadline plus
  a grace second) reports `error: "released"` rather than a fault: the core releases the attempt,
  credits no completed task, and sends an orphaned task back to the front as released work (§4.2,
  §6.4). Throttled nodes idle nine times each task's compute with a fifty-millisecond floor
  (§6.6). Over-capacity assignments are refused, not queued (§4.1).
- **2026-09-02 (WP1.7).** The node message rate limit is 1000 per second, not 20: a node sends
  two messages per task and a tile takes milliseconds (§8.4). Observer snapshots carry the
  program list on page 0 so late observers learn what the machine can run (§8.3). Tiles must be
  RGBA of their placed size or the task fails (§5.2). Snapshot keys are
  `g<generation>/<time>.json.gz` plus a `latest.json.gz` pointer; the suspend and terminate hooks
  write unconditionally (§9.4). Seeded bundles are manifest blobs over `/program.wasm`,
  `/manifest.json`, and `/in/*` (§5.6). The private port gains `GET /snapshot` (§9.3).
- **2026-09-02 (WP1.10).** A presigned PUT must carry the SHA-256 checksum as a **signed header**,
  not as a signed query parameter: with the checksum hoisted into the query, S3 accepts bytes that
  do not match it, and a request carrying it as an unsigned header is refused outright. The store
  passes `signableHeaders`/`unhoistableHeaders` for it and refuses to hand out a URL whose
  signature does not cover the checksum; clients send exactly the signed header set and nothing
  more (§7.1, §7.3). The default loop backs off after a failed execution — five seconds, doubling
  to five minutes, reset by a success — so a broken program cannot spin the machine (§6.8). Ended
  executions beyond the most recent 32 are pruned with their tasks on every tick, keeping the
  ledger and its snapshots bounded (§9.4).
- **2026-09-02 (WP2.1).** A bundle manifest and a filesystem manifest are the same shape, so an
  execution that inherits nothing uses the **bundle hash itself** as its first root (§5.4). The
  bundle's files win over an inherited filesystem on conflicting paths. The expired-root check is
  a fetch of the inherited root before planning, and its absence raises a new `executionWarning`
  observer event with code `expired-root` (§5.4, §8.3). The per-execution filesystem cap
  (`fsBytesCap`, 256 MB) is enforced at fold (§5.5).
- **2026-09-02 (WP2.3).** A launch naming an unknown bundle produces a `resolveBundle` effect; the
  process fetches and validates the bundle (paths under `/in/`, both required files, size caps,
  the module through `validateModuleBytes`) and answers with `programAdded` plus the launch, or
  `bundleRejected` addressed to the asking observer (§5.2). Budgets: `taskCap` 20 000 tasks per
  execution including plan tasks, `launchesPerMinute` 6 per observer covering follow-ups (§5.5).
- **2026-09-02 (WP3.1).** A ledger carries `meta.phase` (`active`, `handing-over`, `drained`);
  only an active control plane assigns work or accepts socket upgrades, and adopting always stamps
  `active` (§9.4). `/adopt` refuses a ledger from a later generation and accepts a repeat of the
  same one, which is what makes a retried rotation safe. `/health` is **not** gated by the fleet
  secret — the operator scripts poll it and it carries only counts; `/handover`, `/adopt`,
  `/drain`, `/snapshot`, and `/diag` are (§8).
- **2026-09-02 (WP3.2).** The successor is always launched with the latest snapshot key, so a
  failed `/handover` costs repeated work rather than state (§9.4). The pointer carries a `pending`
  record naming a launched-but-not-promoted successor; the next run finishes, forgets, or
  terminates it. Rotate has **no reserved concurrency** (the account cannot spare it); overlapping
  runs are made safe by the per-generation client token, the pointer, and idempotent
  handover/adopt instead (§9.2).
- **2026-09-02 (WP2.2).** The `bars` view has a byte format:
  `"TFBR" u32 version | u32 count | count × (str label | f64 value)`, values finite (§5.1, §5.3).
  Word count's map tasks own the words that *start* inside their byte range — they skip a word
  straddling the start and read past the end to finish one straddling the end — which is the
  precise form of "extended to whitespace on both ends" (§5.6). The corpus is normalized at build
  time beyond stripping the boilerplate: typographic apostrophes, quotation marks, dashes, and a
  few accented letters become ASCII, and the edition's transcriber's notes go; the word rule is a
  byte rule (ASCII letters and apostrophes) and non-ASCII bytes separate words. The attribution
  file ships inside the bundle as `/in/ATTRIBUTION.txt`.

- **2026-09-02 (WP2.4).** The in-page compiler is asc bundled with Bun for the browser, minified
  (1.6 MB), its Node-only imports left as dynamic imports that a worker never takes; binaryen is
  served **as is** as a sibling asset (13.6 MB, almost all of it the compiler's own WebAssembly —
  a minifying pass made it larger), not minified as §5.6 planned. Both load in a module worker
  only when the editor opens. A page compile is byte-identical to the build's (pinned under Bun
  and in Chromium). A page-built bundle is the manifest blob seeding produces, except its
  manifest is compact JSON, so the same program uploaded from the page and shipped in the image
  are two bundles and two program records (§5.6, §7.3). `@tabframe/sandbox` exports a
  `./validate` subpath for the page.
- **2026-09-03 (WP1.9).** Found by the churn simulation. Results and presigns do not count
  against the per-node message bucket at all: they answer assignments, which `maxInFlight` already
  paces (§8.4; WP1.7 had raised the bucket to 1000 a second for the same reason). Agreement means
  two nodes (§6.5, D7): a repeat report from the same node in a round adds no evidence, the second
  attempt of a round never goes to a node that already reported, and the vote after two contested
  rounds counts distinct nodes; with the toggle on, a task on a cluster of one waits for a second
  node. Once a stage is folded, or a plan task's spec consumed, its results are sealed: a later
  mismatch is announced and counted but withdraws nothing, since the manifest that holds the
  output has already advanced the stage (§6.5, §6.6). Two more invariants (§6.10): a node holds
  only work of the running execution, and an ended execution leaves nothing pending or assigned.
  Snapshot pages are packed by bytes as well as by row count, since 256 rows of done tiles exceed
  the message cap (§8.3). A result closes the attempt it names; a report for another attempt of
  the same task is evidence only, so a stale report never closes a newer attempt (§6.5). D7's
  "recompute from scratch" goes to nodes that have not reported on the task whenever one has a
  free slot; a tie after two contested rounds is not a majority and starts another round, up to
  four, after which report order breaks it.
- **2026-09-02 (WP3.3).** A cloud core names itself `core-<microvmId>`, which is how the ledger
  links a node to the core it launched; no registration message (§6.8). Core records travel in the
  ledger and are inherited at adopt with their node links cleared. Cores launch with **no ingress
  connector** and no idle policy. The fleet policy is gated by `config.cloudCores`, true only for
  the MicroVM image with an image ARN, a core role, and a session URL — a laptop wakes and sleeps
  but has no fleet (§6.8, §12).
- **2026-09-02 (WP3.4).** Local mode can boot neutral (`TABFRAME_LOCAL_NEUTRAL`) so `dev:rotate`
  drives the real run hook and the real rotate handler with control-plane processes standing in for
  MicroVMs (§12). A run payload with an empty `storeBase` leaves a control plane serving blobs from
  its own port; locally each generation has its own in-memory store, so a rotation loses earlier
  blobs and the local test rotates within one stage. On AWS the store is shared and this does not
  arise (§7.1).
- **2026-09-02 (WP3.5).** A bundled image cannot spawn itself as a worker thread: the sandbox
  worker is bundled as a second entry point, staged beside `main.js`, and named to the process by
  `TABFRAME_SANDBOX_WORKER` (§4.2, §11.3). The fleet's private-port calls retry on 429 and 5xx
  (§9.4). **Measured:** one client holds about 16 concurrent sockets through a MicroVM endpoint
  before it answers 429, and open sockets crowd out the fleet's own requests to the same endpoint —
  so the ledger's 256-node cap is not the binding constraint (§8.4, §9.1;
  `docs/m3-verification.md`). A rotation with a render in flight costs about 8.4 s of churn.
- **2026-09-02 (WP2.5).** The `taskDone` observer event and the task view carry an optional
  `log` (inline text or a blob hash), the shape the node already reports to the control plane; the
  dashboard renders it when present and says plainly when the wire did not carry one (§8.3). The
  `bars` view draws the single output of the last stage; a last stage with several outputs is
  listed in the files panel instead (§5.1). The files panel browses any root the execution has had,
  not only the current one; roots are the stage strip's links (§5.4). The browser suites run on one
  Playwright worker: they share a local control plane and, since WP2.3, an upload really launches
  (§12).

  four, after which report order breaks it. Freeze is terminal on the node **record** too: a later
  `throttleHalf` does not downgrade a frozen node to throttled, since `fill` must keep skipping a
  worker that computes nothing until the silence window declares it gone (§4, §6.7).
- **2026-09-02 (WP2.7).** Seeding is idempotent by bundle hash rather than "only when the ledger
  has no programs": a control plane that adopts a predecessor's ledger still adds programs the
  image ships that the ledger does not have, which is what lets a deploy-as-rotation deliver a new
  program (§5.6, §9.4).
- **2026-09-02 (WP4.5).** The endpoint ceiling is explained: **16 concurrent connections per
  MicroVM**, the account's non-adjustable *Concurrent connections per 2 vCPU MicroVM* quota, the same
  at 512 MiB and 6 GB, per MicroVM rather than per token, process, or source (§9.7). The M0 record's
  "250 sustained sockets" was a counting error — that script attached its close handlers after the
  loop and never heartbeated during it, so the sockets it counted as open had already been declared
  gone; about sixteen were alive. `docs/m0-verification.md` carries the correction. The account's
  Lambda concurrency increase to 1000 was granted; the design's "default of 10" wording is
  historical. Scaling to thousands of clients is an architecture decision, not a tuning one; the
  options are in §9.7 and the plan's WP4.6.
- **2026-09-02 (WP4.4).** The demo script runs unattended against the deployed machine
  (`mise run demo`), and its first runs fixed the fleet policy: a killed or frozen cloud core has
  its MicroVM terminated with the command, and a core with no node for two minutes — never said
  hello, or its node left — is retired and replaced (§6.8). Before, a `kill half` that picked a
  core left a live, unlinked MicroVM that the policy (which counts records) never replaced.
  Seeding also retires unshipped drops nobody has run in the ledger's memory after an hour, so
  runbook uploads do not clutter the program list; the snapshot diet clears file maps on their
  own, not only with the tasks.

- **2026-09-02 (WP6.1).** Stop and Start from the page (§6.7): Stop ends the running execution,
  drops the loop's queued continuations (a person's queued launches stay), and holds the loop —
  `meta.loopStopped`, carried by snapshots and rotations — until Start, which also clears any hold
  or backoff (§6.8). The snapshot's machine view says `stopped`.

- **2026-09-02 (WP4.4, later the same day).** What the unattended runs kept finding, each fixed
  in the core: agreement under redundancy is counted and announced as a verification (it never
  was, so the toggle's counter never moved); a person's launch holds the stage for twenty seconds
  before the loop — its new launches *and* its queued continuations — takes it back (§6.7, §6.8),
  and the snapshot shows the execution that ended last when nothing runs (§8.3); an adopted core's
  link grace runs from the adoption, not its launch (every rotation had been terminating every
  core); a node whose host cannot instantiate the module reports *released*, not a program fault
  (§4.2, D7). The dashboard holds controls issued between subscribes for the next live socket.
  The demo is scoped to ten nodes across two dashboards for the sixteen-connection endpoint (§9.7).

- **2026-09-02 (WP4.9).** The image owns the names it ships: seeding retires a record under a
  shipped name whose bundle is not the shipped one and moves the default loop to the shipped
  program when the loop's bundle is gone or retired (§6.8, §9.4). A retired program is hidden,
  refuses launches (so its follow-up chain ends), and is dropped once no execution refers to it.
  Found by the first verify-m1 on the paced image: the machine kept rendering the previous
  Mandelbrot under a second `mandelbrot` record. Ended executions beyond the two most recent lose
  their file maps with their tasks; inheritance reads the map from the inherited root's manifest
  blob rather than the ledger's copy (§5.4), which is what let the maps go. Deployed snapshot
  before: 917–967 KB gzipped; resume latency measured at 4.1 s to the first 200 via auto-resume.

- **2026-09-02 (WP4.8).** CI is a gate, not a report: `main` must be green in CI before the next
  work package starts (§11). The churn simulation builds the demo programs on demand when
  `programs/*/dist` is absent, so `bun test` works on a fresh checkout; CI also builds them
  explicitly.
- **2026-09-03 (WP1.9 fleet).** The churn simulation now runs the cloud-core fleet: `launchCore`
  becomes a MicroVM that boots and dials in as `core-<microvmId>`, `terminateCore` destroys one,
  and a `--drill` ending destroys a core, empties the dashboard until the machine sleeps, and
  brings a visitor back (§6.8, §12). §6.8 needed no change. **The process does:** nothing calls
  `CoreFleet.gone()`, so a core whose MicroVM dies keeps its ledger record until the four-hour
  ceiling and is never replaced; the simulation models the poller the process still needs.
  `checkInvariants` gained one invariant: a core's node link names a live node of that core's own
  host (§6.10).
- **2026-09-02 (WP3.3 follow-up).** The process polls which of the ledger's cores are gone
  (`TABFRAME_CORE_CHECK_MS`, 30 s) and reports `coreGone`, closing the gap the churn simulation
  found: the policy counts records, and a dead MicroVM kept its record until the age ceiling
  (§6.8). A fresh ledger's clocks now start at the real time; with the zero default a new control
  plane believed nobody had watched it for decades and started asleep.
- **2026-09-02 (WP4.2).** The MicroVM platform delivers only the first line a process writes to
  CloudWatch (stdout and stderr alike); runtime observability is `/health`, `/diag`, the S3
  snapshots, and the dashboard (§9.3, §11). The functions' log groups are kept fourteen days via
  `logRetention`, because Lambda created them before any stack could. `/diag` performs a store
  put-and-get round trip.
- **2026-09-02 (WP4.3).** Mandelbrot gets exact interior shortcuts (cardioid, period-2 bulb, and
  Brent periodicity on f64 equality — output unchanged, checked against the goldens) and retuned
  presets that keep `ss² × maxIter` at or under about 7 000, so the worst tile is about 300 ms
  under Node and under the two-second deadline floor in a tab; the default frame is 22 s of Node
  compute, about a minute in one browser tab (§5.6, §6.4). Word count needs no read batching: the
  whole program is 200 ms of compute (§5.6). Ended executions keep their records for 32 frames but
  their tasks for only the last two (`KEEP_ENDED_TASKS`), which takes the deployed five-second
  snapshot from 2.2 MB gzipped to about a tenth of that (§9.4).

- **2026-09-02 (WP4.1).** The dashboard's flashes cover every event that moves a task — taken
  back, twinned, verified, retracted — not only reassignments (§6.7), and each leaves a pulse the
  page lists in words. Released work has its own colour, distinct from never-assigned work. A
  rotation or a sleep is a banner with the next generation and a countdown to the reconnect rather
  than a line in the notice strip, and the canvas stays on screen while the observer reconnects, as
  §9.4 promises. A ledger panel shows, per settled task, the output hash, the size, and where the
  bytes live, making the hashes-not-bytes claim visible on the page.
