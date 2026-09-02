# Tabframe — design rationale

The short written rationale the assignment asks for, answering its five questions in order. The
design record (`design.md`) is the long version; its drift log is where most of what follows was
learned.

## Why this theme, why this approach

I wanted a distributed computer with **no servers doing the compute**: a machine assembled live
from browser tabs that people open and close at will, that stays *correct* through that churn,
and that is programmed like one elastic machine rather than like a fleet of workers. The
assignment offered a coordinator-and-workers demo; I chose to push on the word *computer*. A
program is a WebAssembly module with `plan` and `run`, both of which execute on the cores; the
control plane never runs program code, not even the planner. Mandelbrot is the money shot because
a tile landing is legible; word count is there because a machine that can only draw fractals is a
screensaver. Both ship through the same path as anything a reviewer writes in the in-page editor.

Three constraints carry the whole fault-tolerance story, and I took them literally rather than as
guidance: tasks are idempotent and delivered at least once; results are single-assignment and
memoized by hash; the control plane holds hashes and never bytes. Everything else is consequence.
A dead core is a non-event. Two cores computing the same tile is a verification, not a waste. A
control plane that dies is replaced from a five-second-old snapshot and nobody's work is wrong.

The hosting choice was deliberate too. The control plane runs in an AWS Lambda MicroVM — the
stateful Firecracker product, not a Lambda function — which I wanted to learn, and which forced a
useful discipline: the control plane is rotated every hour with work in flight, so "even the
control plane is churn" is not a slogan but a scheduled event, and a deploy is just a rotation.

## What is non-obvious

Most of it was learned by running the thing on AWS, not by designing it; the drift log at the end
of the design record is the honest history.

- **Failure needs no error path.** Because a task may run anywhere, twice, or halfway, the
  program's API has no failure type at all, and the control plane's whole response to a vanished
  core is to release its attempts to the front of the queue. A node that gives up on a task at its
  own deadline reports *released*, not *error*: the machine distinguishes a slow core from a broken
  program, and only the second fails an execution.
- **The checksum pin was silently off.** The store's guarantee — the bucket refuses bytes that do
  not hash to their key — rests on the SHA-256 being part of the presigned PUT's signature. The AWS
  signer hoists it into the query string by default, where S3 ignores it: a tampered body was
  accepted with a 200 until a probe against the real bucket caught it. It has to be a *signed
  header*, and the store now refuses to hand out a URL whose signature does not cover it.
- **The binding limit was not the one in the design.** The ledger caps nodes at 256; a MicroVM
  endpoint accepts **16 concurrent connections**, a non-adjustable quota that scales only with a
  vCPU class the API does not let you choose. An earlier measurement had reported 250 sustained
  sockets, and it was a counting error. Worse, open client sockets crowd out the fleet's own calls
  to the control plane's private port — so a rotation under load could not always hand its ledger
  over. The design survived because its failure path was already the normal path: the successor
  boots from the latest snapshot whether or not the handover happens, and idempotent tasks make
  the few seconds of repeated work harmless. The churn measured 8.4 s either way.
- **Small things that are only obvious afterwards.** A bundled single-file image cannot spawn
  itself as a worker thread, so the sandbox worker ships as a second entry point. Seeding the
  demo programs "on first adopt" never happens twice — every generation adopts its predecessor's
  ledger — so a program added in a later deploy never appeared until seeding became idempotent by
  bundle hash. A control plane with a failing program relaunched it ten times a second until the
  default loop learned to back off. A fresh ledger whose clocks defaulted to zero believed nobody
  had watched it for fifty years and was born asleep. Agreement, with the redundancy toggle on,
  has to mean two *nodes*: a node reporting twice is not evidence, and a lying node that reconnects
  is a new node, which is the toggle's honest limit.
- **Running it unattended found what running it by hand had not.** The demo script as a
  Playwright suite (WP4.4) found a killed cloud core that stayed alive, unlinked, and unreplaced
  (the fleet counted records, not links), a deploy that left the machine rendering the *previous*
  Mandelbrot under a second record of the same name (seeding now retires what it supersedes and
  moves the loop), and dashboard controls lost in the few hundred milliseconds of a silent
  resubscribe (they are now held for the next socket). None of these showed in a demo run by hand,
  because a hand pauses between clicks.

## Key decisions and trade-offs

- **One active control plane, not consensus.** Authority is a generation stamp plus a pointer;
  handover is a five-step rotation; recovery is a snapshot at most five seconds stale. The cost is
  a window in which the machine has no control plane — measured at 8.4 s of churn per rotation —
  and a single point of failure I state rather than hide. Raft over the ledger is the first
  extension, and I did not build it.
- **Hashes only in the control plane.** Forced by the platform: a MicroVM endpoint's bandwidth is
  capped by its size, so result bytes could not pass through it even if the design had wanted
  them to. The consequence is a control plane that can be snapshotted in a kilobyte-per-task and
  handed over in one HTTP call, and a dashboard that re-hashes every tile before painting it.
- **Planning as a task.** The planner runs on a core like any task, so a lost planner is a lost
  task and a stage spec is an auditable blob — at the price of one extra round trip per stage and
  a planner that cannot see the cluster except through frozen hints.
- **Determinism as a requirement.** No clock, no randomness, no network imports, no NaN in
  outputs, planner hints frozen into the task input. This is what makes a duplicate result a
  *check*: the same bytes come out of a browser tab and a Firecracker VM, and 640 of 640 tiles
  matched goldens produced on a different machine.
- **The redundancy toggle's semantics.** Off, a later disagreeing duplicate un-paints and
  recomputes; on, a tile counts only when two nodes agree, a disagreement recomputes from scratch,
  and a majority settles it after two contested rounds. I chose retraction over "never retract"
  because a wrong tile on screen is worse than a flicker, and two-way agreement with a tie-break
  over K-way voting because the machine's hosts are not adversarial.
- **A sandbox, not a capability model.** Five host imports, a memory maximum, a deadline that
  terminates the worker, byte caps on writes and logs. Enough to run a stranger's WebAssembly
  without it reaching anything; not enough to bill them for it. Server-side C→WASM compilation
  was cut in favour of AssemblyScript in the browser and bring-your-own-`.wasm`.
- **What was cut, and why.** Channels between running tasks and a mutable key-value store, because
  restartability is the whole point and both break it; a WebRTC peer mesh, intra-tab
  `SharedArrayBuffer` multicore, a RISC-V interpreter, because none of them changes what the
  machine *is*. A consensus control plane, K-way voting, and a client edge that scales past sixteen
  sockets per control plane are the extensions I would build next rather than the corners I
  rounded.
- **MicroVMs, knowing what they cost.** The connection ceiling means one control plane serves
  about fifteen tabs, and the demo is scoped to that. The decision on record is to document it
  now and evaluate hosting the control plane on an EC2 instance after packaging — no per-VM
  connection quota, the same process and protocol, but a different rotation mechanism and the
  loss of snapshot boot and suspend/resume.

## How I would extend it

In order of what I would do first:

1. **Scale the client edge.** Either move the control plane to an EC2 host, or put an API Gateway
   WebSocket API in front of it and push through `PostToConnection`; the core already speaks to
   connections through a `Transport` seam, so the protocol survives either.
2. **Kill the single point of failure** with a consensus-backed ledger over three MicroVMs, keeping
   the generation stamp as the client-visible truth.
3. **Untrusted hosts:** K-way redundant execution with voting, so that a machine whose cores are
   strangers' tabs can be trusted by the person who launched the program.
4. **Cheaper reads:** a WebRTC mesh so a tile's neighbours fetch inputs from each other rather than
   from CloudFront, and `SharedArrayBuffer` multicore inside a tab.
5. **Observability:** the platform forwards only the first line a MicroVM process prints, so the
   machine is read through its own `/health` and `/diag` (`mise run health`, per core with
   `--cores`) and through S3; a log shipper of its own is the next step.

## How long it took

The assignment grades scoping against an eight-hour ceiling and asks for the time spent. This
build went well past that ceiling by deliberate choice: an evening of brainstorming, a day of
design walkthrough (the decisions D1–D20 and the design record), and then the build itself — M0
to M5 across one long session from the evening of 2026-09-01 through 2026-09-02, every milestone
verified against AWS. I kept a time log with two columns because the honest number has two parts.
`docs/timelog.md` records **<<total hours>>** of wall-clock session time in total, of which
**<<developer hours>>** were my own hours at the keyboard.

The rest was an AI coding agent working under my direction: the design walkthrough, the
decisions register D1–D20, the scoping calls above, and every gate — deploys, the budget, what
was cut — are mine; the agent wrote the code, the tests, and the documents under the ground rules
in `docs/plan.md`, with a work-package document and a passing CI run behind every merge. The
session transcripts are submitted with the code so the division of labour can be read rather than
taken on faith.
