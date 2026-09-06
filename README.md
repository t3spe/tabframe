# Tabframe

A fault-tolerant distributed computer whose cores are browser tabs and Lambda MicroVMs
(Firecracker), programmed with WebAssembly. Every worker is a core: a thread in someone's tab, or
one of the two MicroVMs, the *cloud cores*. Open the page and your tab is a core. Close it and the
machine keeps computing, correctly. The control plane that schedules the work is itself replaced
every hour, with the work in flight.

Deployed at **https://d2w9z8juw4oo76.cloudfront.net**. The page lends one core when it opens and
shows the machine rendering a Mandelbrot frame with whoever else is there. The guided tour is
[`docs/walkthrough.md`](docs/walkthrough.md): five clicks that show the fault tolerance, then every
screen and state.

## What it is

A program is one WebAssembly module with two entry points and a manifest. `plan` turns parameters
and the previous stage's outputs into the next stage's tasks; `run` turns one task's input into
bytes. Both execute on cores. The control plane runs no program code, not even the planner. A
program's only view of the world is a per-execution filesystem of content-addressed blobs: it has no
clock, no randomness, no network, and no failure type anywhere in its API.

Three programs ship with the machine and go through the same path as anything you write in the
in-page editor: a distributed **Mandelbrot** render (640 tiles of 64×64 per frame, presets that
advance while anyone watches); a three-stage **word count** over *Moby-Dick* (map, reduce, merge to
an exact top-25); and **tiny GPT**, an 822 k-parameter character-level transformer whose whole
forward pass runs in WebAssembly on the cores, four milliseconds a token and the same bytes on every
core. You can also compile your own: the editor holds every program's source and the AssemblyScript
compiler runs in a browser worker. The programs and how they are checked:
[`programs/README.md`](programs/README.md); how to write one, and what a program may and may not do:
[`packages/sdk-as/README.md`](packages/sdk-as/README.md); the transformer's feasibility note, with
the measured numbers: [`docs/feasibility-transformer.md`](docs/feasibility-transformer.md).

## The idea

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

So a dead core is a non-event: its attempts are released and the work goes back to the front of the
queue. And because the ledger is metadata only, the control plane can be snapshotted every five
seconds, handed to its successor, and replaced. Deploys use the same handover as the hourly
rotation. Each of these claims was measured against the deployed machine, kill-half and rotation
included: [`docs/evidence.md`](docs/evidence.md).

## Architecture

![Architecture: browser tabs and cloud cores run the same orchestrator and talk WebSocket to one control plane on a Lambda MicroVM; its ledger is snapshotted to S3 every five seconds and handed to the successor at the hourly rotation; results and the page live in S3 behind CloudFront; the fleet's session and rotate functions and an SSM pointer stand beside it.](docs/diagrams/architecture.svg)

- **Orchestrator** (`packages/node`, what a core runs): one Web Worker owns the socket and the
  heartbeat; a disposable sandbox worker executes program code and is terminated at the deadline.
  The same orchestrator runs in a tab and inside a MicroVM.
- **Core** (`packages/core`): the pure scheduler, `apply(ledger, event) → effects`, no I/O.
  Three-tier fill (released work, pending work, speculative twins for overdue attempts), deadlines
  at three times the median compute with a two-second floor, verification, execution lifecycle, the
  fleet and sleep policy, paged snapshots, and the invariants every test checks.
- **Control plane** (`packages/control-plane`): the process around the core, with sockets, the
  lifecycle hooks, seeding of the shipped programs, gzipped S3 snapshots, handover, adopt, and
  drain.
- **Store** (`packages/store`): the content-addressed store with a local driver and an S3 driver
  whose presigned PUTs pin the SHA-256 as a signed header.
- **Sandbox** (`packages/sandbox`): validation (five `tf` imports, four exports, a declared memory
  maximum), a fresh instance per task, filesystem glue, deadline kill.
- **SDK** (`packages/sdk-as`) and **programs** (`programs/`): AssemblyScript mirrors of the ABI, the
  demo programs, goldens produced by single-node runs.
- **Web** (`packages/web`): the dashboard, with verified tiles re-hashed before they are painted,
  the task grid, counters, cluster controls, the programs and files panels, and the editor.
- **Fleet** (`packages/fleet`) and **infra** (`packages/infra`): the session and rotate Lambda
  functions, the operator scripts, and the four CDK stacks (Core → Image → Fleet → Web).

The design record, [`docs/design.md`](docs/design.md), is the source of truth; its decisions
register (D1–D20) says what was chosen and why, and its drift log at the end says what changed
while building and why.

## Limits, stated plainly

- **One MicroVM endpoint accepts 16 concurrent connections.** That is an AWS quota, not adjustable,
  the same at every VM size we can launch; measured, then found in the account's Service Quotas
  ([design §9.7](docs/design.md)). One control plane therefore serves about seven browser tabs that
  each lend a node (fourteen that only watch), and the ledger's 256-node cap is a property of the
  scheduler, not of the deployment. Scaling the client edge is deferred: the ceiling is documented,
  and an EC2 host for the control plane is the candidate (design §9.7).
- **One active control plane at a time.** Authority is a generation stamp and a pointer, not
  consensus. A control plane that dies without handing over is replaced from its last snapshot, at
  most five seconds stale, and idempotent tasks make that safe; a consensus control plane is an
  extension, not a feature; the client edge comes first.
- **Programs are trusted to the extent the sandbox allows.** Five host imports, no clock, no
  randomness, no network, a memory maximum, a deadline, and byte caps on writes and logs. No
  capability model beyond that, and no K-way voting beyond two-way verification with a majority
  tie-break.
- **Cut on purpose:** channels between running tasks and a mutable key-value store (restartability
  is the whole point), a RISC-V interpreter, a WebRTC peer mesh, intra-tab `SharedArrayBuffer`
  multicore, server-side C→WASM compilation.

## Run it

Tooling is managed by [mise](https://mise.jdx.dev): Node.js 22 is the runtime, Bun is the developer
toolchain, and every task lives in [`mise.toml`](mise.toml).

```sh
mise trust && mise install && mise run install   # tools, workspace dependencies, the Playwright browser
mise run dev                                     # the whole machine on a laptop → http://127.0.0.1:4080
mise run test                                    # unit and integration tests, then the browser tests
```

The local topology runs the same code as the cloud. What it starts, every task, the test layers, and
what CI runs: [`docs/development.md`](docs/development.md). Deploying needs an AWS account and one
command. A deploy is a rotation: the new image version is published and the rotate function hands
the ledger to the next generation. The prerequisites, the steps, rollback, health, logs, and cost
are in [`docs/runbook.md`](docs/runbook.md).

## Documents

[`docs/README.md`](docs/README.md) is the index, in reading order:

- [`docs/design.md`](docs/design.md): the design record, with the decisions register D1–D20, the
  system, the wire, hosting, security, and tooling; its drift log at the end says what changed while
  building and why.
- [`docs/walkthrough.md`](docs/walkthrough.md): the page's contract, the five-click tour, then every
  screen, state, and control, checked by a browser test.
- [`docs/development.md`](docs/development.md): the machine on a laptop, the tasks, the tests, CI.
- [`packages/sdk-as/README.md`](packages/sdk-as/README.md) and
  [`programs/README.md`](programs/README.md): how to write a program, and the three that ship.
- [`docs/feasibility-transformer.md`](docs/feasibility-transformer.md): the transformer on the
  cores, with the measured numbers.
- [`docs/evidence.md`](docs/evidence.md): what is measured, and how to re-run each check.
- [`docs/runbook.md`](docs/runbook.md): operating the deployed machine.
- [`docs/implementation/`](docs/implementation/README.md): how it was built, one note per work
  package.

## License

Tabframe is licensed under the **GNU Affero General Public License v3.0**; see [`LICENSE`](LICENSE).
The word-count corpus is *Moby-Dick* from Project Gutenberg, with the attribution in
[`programs/wordcount/README.md`](programs/wordcount/README.md).
