# Tabframe

A fault-tolerant distributed computer whose cores are browser tabs and Firecracker microVMs,
programmed with WebAssembly. Every worker is a core — a thread in someone's tab, or one of the two
MicroVMs in AWS, the *cloud cores*. Open the page and your tab is a core. Close it and the machine keeps
computing, correctly. The control plane that schedules the work is itself replaced every hour, with
the work in flight.

Deployed: **https://d2w9z8juw4oo76.cloudfront.net** — the page lends one core when it opens, and
shows the machine rendering a Mandelbrot frame with whoever else is there.

**Try it, in five clicks.** **spawn N** (N is one fewer than your machine's cores so the tab keeps a thread; the counters follow), kill half (tiles are taken back and finish
elsewhere), redundancy on (the verified counter moves), editor ↗ (change `CYCLE`, compile, launch:
your program goes ahead of the loop), the ledger tab (hashes, not bytes). `?observe` lends no cores,
`?demo=1` runs a scripted cluster inside the page, and a rotation banner every hour is expected.

## What it is

A program is one WebAssembly module with two entry points and a manifest. `plan` turns parameters
and the previous stage's outputs into the next stage's tasks; `run` turns one task's input into
bytes. Both execute on cores — the control plane runs no program code, not even the planner. A
program's only view of the world is a per-execution filesystem of content-addressed blobs: it has
no clock, no randomness, no network, and no failure type anywhere in its API.

Three programs ship with the machine and go through the same path as anything you write in the
in-page editor: a distributed **Mandelbrot** render (640 tiles of 64×64 per frame, presets that
advance while anyone watches); a three-stage **word count** over *Moby-Dick* (map by byte range,
reduce by partition, merge to a top-25); and **tiny GPT**, an 822 k-parameter character-level
transformer trained on that same corpus, whose whole forward pass runs in WebAssembly on the cores —
one continuation per task, four milliseconds a token, the same bytes on every core
(`docs/feasibility-transformer.md`). You can also compile your own: the editor holds every
program's source and the AssemblyScript compiler runs in a browser worker.

## Why it looks the way it does

Three constraints carry the whole fault-tolerance story; everything else follows from them.

1. **Tasks are idempotent and delivered at least once.** A task may run on two cores, be killed
   halfway, or be handed to a third after its holder vanishes. The program never knows.
2. **Results are single-assignment, memoized by hash.** The first accepted result for a task is
   final; a duplicate is compared, not repeated. With the redundancy toggle on, two cores must
   agree byte for byte before a tile counts, and a disagreement recomputes from scratch and is
   settled by majority after two contested rounds.
3. **The control plane holds hashes, never bytes.** Results, written files, and logs go from the
   core straight to a content-addressed store (S3 behind CloudFront); the control plane learns a
   hash and a size. The store computes the hash on upload and refuses any other name.

So a dead core is a non-event: its attempts are released and the work goes back to the front of
the queue. And because the ledger is metadata only, the control plane can be snapshotted every five
seconds, handed to its successor, and replaced — deploys use the same handover as the hourly
rotation.

## Architecture

```
  browser tabs                        cloud cores (Lambda MicroVMs, same image)
  ┌─────────────────┐                 ┌─────────────────┐
  │ orchestrator ─┐ │  ...            │ orchestrator ─┐ │  ...
  │ sandbox worker│ │                 │ sandbox worker│ │
  └───────┬───────┘ │                 └───────┬───────┘ │
          │ WebSocket (hello, assign, result-by-hash, presign)
          ▼                                   ▼
  ┌──────────────────────────────────────────────────────┐   hourly rotation:
  │ control plane  ·  one Lambda MicroVM, generation g   │   launch g+1 → handover →
  │   ledger: nodes, executions, tasks, hashes           │   adopt → flip pointer →
  │   scheduler: fill, deadlines, twins, verification    │   drain g (jittered)
  └───────┬────────────────────────────┬─────────────────┘
          │ snapshot every 5 s          │ presigned PUT / GET by hash
          ▼                             ▼
     S3 snapshots                  S3 blobs behind CloudFront  ◄── page, blobs, uploads
                                        ▲
  fleet: session (vends endpoint + token) · rotate (hourly, also the deploy path) · SSM pointer
```

- **Node** (`packages/node`): one Web Worker owns the socket and the heartbeat; a disposable
  sandbox worker executes program code and is terminated at the deadline. The same orchestrator
  runs in a tab and inside a MicroVM.
- **Core** (`packages/core`): the pure scheduler — `apply(ledger, event) → effects`, no I/O.
  Three-tier fill (released work, pending work, speculative twins for overdue attempts), deadlines
  at three times the median compute with a two-second floor, verification, execution lifecycle,
  the fleet and sleep policy, paged snapshots, and the invariants every test checks.
- **Control plane** (`packages/control-plane`): the process around the core — sockets, lifecycle
  hooks, seeding of the shipped programs, gzipped S3 snapshots, handover, adopt, drain.
- **Store** (`packages/store`): the content-addressed store with a local driver and an S3 driver
  whose presigned PUTs pin the SHA-256 as a signed header.
- **Sandbox** (`packages/sandbox`): validation (five `tf` imports, four exports, a declared memory
  maximum), a fresh instance per task, filesystem glue, deadline kill.
- **SDK** (`packages/sdk-as`) and **programs** (`programs/`): AssemblyScript mirrors of the ABI,
  the demo programs, goldens produced by single-node runs.
- **Web** (`packages/web`): the dashboard — verified tiles re-hashed before they are painted, the
  task grid, counters, cluster controls, the programs and files panels, the editor.
- **Fleet** (`packages/fleet`) and **infra** (`packages/infra`): the session and rotate Lambda
  functions, the operator scripts, and the four CDK stacks (Core → Image → Fleet → Web).

The design record, [`docs/design.md`](docs/design.md), is the source of truth; its decisions
register (D1–D20) says what was chosen and why, and its drift log at the end says what changed
while building and why.

## What is measured

Every milestone was verified against the deployed machine; the records are in `docs/`.

| Claim | Evidence |
|---|---|
| Kill half the cluster mid-frame and the frame still completes, bit for bit | 6 nodes from tabs, 3 killed at tile 128: **640 of 640 tiles match the goldens** produced by a single Node process on another machine ([`m1-verification.md`](docs/m1-verification.md)). The browser suite repeats it with ten nodes in one tab. |
| A program edited and compiled in the page runs on the cluster | compiled in the browser in ~3 s, byte-identical to the build's module; the edited frame's tiles differ from the unedited goldens ([`m2-verification.md`](docs/m2-verification.md)) |
| Word count is exact | the top-25 over *Moby-Dick* equals the JavaScript reference **hash for hash** |
| A program fault is visible, not fatal | a planner that traps fails its execution with its own abort message and the machine returns to its loop |
| The control plane rotates with a render in flight | **8.4 s of churn** from the drain to the first tile of the new generation, four rotations, 8.4–8.5 s each; the session function peaked at 3 concurrent executions with no throttles ([`m3-verification.md`](docs/m3-verification.md)) |
| Correct under arbitrary churn | a discrete-event simulation with virtual nodes running the real WebAssembly programs, seeded chaos (joins, leaves, crashes, freezes, hidden tabs, every control, a lying node, the fleet), invariants after every event, goldens at the end — **1000 long seeds pass** ([`wp-1.9-churn-sim.md`](docs/implementation/wp-1.9-churn-sim.md)) |

560 unit and integration tests (85 % line-coverage threshold on the core packages; counted 2026-09-04), 31 browser
tests in Playwright, and CI on every push with no AWS credentials.

## Limits, stated plainly

- **One MicroVM endpoint accepts 16 concurrent connections.** That is an AWS quota, not
  adjustable, the same at every VM size we can launch — measured, then found in the account's
  Service Quotas ([design §9.7](docs/design.md)).
  One control plane therefore serves about seven browser tabs that each lend a node (fourteen that only watch), and the ledger's 256-node cap is
  a property of the scheduler, not of the deployment. Scaling the client edge is an architecture
  decision recorded in the plan (WP4.6): document it for now, evaluate an EC2 host for the control
  plane after packaging.
- **One active control plane at a time.** Authority is a generation stamp and a pointer, not
  consensus. A control plane that dies without handing over is replaced from its last snapshot,
  at most five seconds stale, and idempotent tasks make that safe; a consensus control plane is
  an extension, not a feature (the second in the rationale's list; the client edge comes first).
- **Programs are trusted to the extent the sandbox allows.** Five host imports, no clock, no
  randomness, no network, a memory maximum, a deadline, and byte caps on writes and logs. No
  capability model beyond that, and no K-way voting beyond two-way verification with a majority
  tie-break.
- **Cut on purpose:** channels between running tasks and a mutable key-value store (restartability
  is the whole point), a RISC-V interpreter, a WebRTC peer mesh, intra-tab `SharedArrayBuffer`
  multicore, server-side C→WASM compilation.

## Running it locally

Tooling is managed by [mise](https://mise.jdx.dev): Node 22 is the runtime, Bun is the developer
toolchain, and every task lives in [`mise.toml`](mise.toml).

```sh
mise trust && mise install      # tools: node, bun, aws-cli, gh, cdk
mise run install                # workspace dependencies and the Playwright browser
mise run dev                    # the whole machine on a laptop: control plane, local store,
                                #   two local cores, web bundles in watch mode → http://127.0.0.1:4080
mise run dev:rotate             # a second control plane and a real handover, on the laptop
mise run sim -- --seed 7        # the churn simulation (--long for the long scenario, --drill for the fleet)
mise run test                   # lint, type check, unit and integration tests, browser tests
bun test                        # the unit and integration suites alone
bunx playwright test            # the browser suites alone
```

The local topology runs the same code as the cloud: a control plane process serving blobs from
memory, two Node processes as stand-ins for the cloud cores, and the page from `packages/web/dist`.

## Deploying it

Needs an AWS account with a profile named `tabframe` (the operator identity, used for `cdk`
only; every application component runs under a least-privilege role CDK creates) and a gitignored
`.env.local` holding `TABFRAME_ACCOUNT_ID` and `TABFRAME_BUDGET_EMAIL` (the address the $100/month
notification-only budget alerts).

```sh
mise run whoami                 # asserts the identity is the Tabframe account; every AWS task depends on it
AWS_PROFILE=tabframe cdk bootstrap   # once; the profile no longer rides on every task (WP8.2)
mise run deploy                 # build → test → cdk deploy (four stacks) → up: a rotation onto the new image
mise run verify:m1              # browser tabs render a frame on the deployed machine; kill half; golden hashes
mise run verify:m2              # edit and compile in the page; word count; a program fault
mise run verify:m3              # a rotation under load: churn seconds, drain jitter, session concurrency
mise run demo -- --repeat 3     # the demo script, unattended, against the deployed machine (--video records)
mise run health -- --cores      # /health and /diag of the control plane, and each cloud core's own /health
mise run down                   # off: disable the schedule, terminate every MicroVM, write the off state
mise run up                     # back on
mise run logs                   # tail the MicroVM log group
```

A deploy is a rotation: the new image version is published, the rotate function launches the next
generation, hands the ledger over, flips the pointer, and drains the old one. Rollback is the same
path onto the previous image version.

What it costs is in the design's §9.5: about $0.13 for an hour with a visitor and idle cores, about $3 if
left running all day, near zero suspended. The machine sleeps ten minutes after the last observer
leaves — cores terminated, automatic continuation paused — and wakes on the next visitor.

**During the review period the machine stays up.** The public URL answers; while nobody
watches, the cores are terminated after ten minutes and the control plane suspends after fifteen.
The hourly rotation leaves a suspended control plane alone (since WP8.1; before, it booted a fresh
generation every hour of an idle night), so an untouched machine converges to one suspended
MicroVM, which the platform terminates after seven suspended hours. The first visitor sees
"starting" for the few seconds of a boot, the cores follow, the next hour rotates it, and the loop
resumes while the page is open. `mise run down` turns it off for good; `mise run up` brings it back.

## Reading the repository

| Where | What |
|---|---|
| [`docs/design.md`](docs/design.md) | the design record: decisions D1–D20, the system, the wire, hosting, security, tooling, and the drift log |
| [`docs/runbook.md`](docs/runbook.md) | operating it: the mise tasks, what `/health` says, incidents and what they meant |
| [`docs/walkthrough.md`](docs/walkthrough.md) | the page's contract: every screen, state, and control, checked by `e2e/walkthrough.e2e.ts` |
| [`docs/feasibility-transformer.md`](docs/feasibility-transformer.md) | the small transformer on the cores: the assessment with measured numbers |
| [`docs/implementation/`](docs/implementation/README.md) | how it was built, one note per work package — what, how, why, evidence, drift |
| [`packages/sdk-as/README.md`](packages/sdk-as/README.md) | how to write a program (the in-page guide is cut from it) |
| [`programs/`](programs/) | the three programs that ship, each with its README |

## License and attribution

Tabframe is licensed under the **GNU Affero General Public License v3.0** — see
[`LICENSE`](LICENSE).

The word-count corpus is *Moby-Dick; or, The Whale* by Herman Melville (1851), public domain,
obtained from Project Gutenberg ebook #2701 with the Project Gutenberg header, footer, and license
removed and a few typographic characters normalized to ASCII; it is therefore not a Project
Gutenberg ebook, and the Project Gutenberg License applies to the ebook as distributed at
gutenberg.org, not to this copy. The attribution ships inside the program's bundle as
[`programs/wordcount/in/ATTRIBUTION.txt`](programs/wordcount/in/ATTRIBUTION.txt).
