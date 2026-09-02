# WP2.3 — Launch path

**Milestone:** M2 · **Branch:** `wp/2.3-launch-path` · **Packages:** `packages/core`,
`packages/control-plane`

## What

Everything between "a person has a program" and "the cluster is running it".

- **Uploaded bundles.** A `launch` naming a bundle the ledger does not know is an upload. The core
  answers with a new `resolveBundle` effect rather than a refusal; the process fetches the bundle
  manifest and the two files it must contain, validates them, and either dispatches `programAdded`
  followed by the same launch, or `bundleRejected`, which is reported to the observer that asked
  and to nobody else. The core stays pure: it never parses a manifest or a module.
- **What the process checks** (`packages/control-plane/src/bundles.ts`): the bundle hash resolves
  to a filesystem manifest; it has `/program.wasm` and `/manifest.json`; every other path is under
  `/in/`, so an upload cannot smuggle files into `/out/`, whose names the fold owns; the bundle is
  under 64 MB and the module under `LIMITS.maxModuleBytes`; the program manifest parses; and the
  module passes the same `validateModuleBytes` the sandbox and seeding use — imports, exports,
  size, declared memory maximum. Every refusal names what was wrong, because the person reading it
  is the one who can fix it.
- **Per-execution task budget.** `config.taskCap` (20 000) counts every task an execution creates,
  plan tasks included. A stage spec that would exceed it fails the execution with both numbers,
  before any of those tasks is assigned. This complements the ABI's per-spec cap and the compute
  budget already in place.
- **Per-observer launch rate.** `config.launchesPerMinute` (six) over a sliding minute, charged to
  both `launch` and `runFollowUp`, per observer connection. Over the limit is a `rate-limited`
  error, not a disconnect: the person is not misbehaving, they are impatient.

Queue priority (human ahead of automatic), `skip`, `killExecution`, follow-ups offered rather than
enqueued (D19), the node and observer caps, and failures for traps, conflicts, over-budget and
invalid specs were already in the scheduler; this work package adds their tests to the launch
suite.

## Tests

- `packages/core/src/launch.test.ts`, nine cases: an unknown bundle produces `resolveBundle` and
  nothing else; the replayed launch runs it; a second launch of the now-known bundle goes straight
  through; a rejection reaches only the asking observer and is dropped if that connection has
  gone; a ledger-level refusal (inheriting from an execution that never finished) is reported;
  the launch rate limits per observer with a sliding window and covers follow-ups; the task cap
  fails the execution with both numbers and the plan task counts against it; human launches queue
  ahead of automatic ones; a program record keeps its module and files.
- `packages/control-plane/src/bundles.test.ts`, six cases over a real compiled module: a
  well-formed upload with an input; a bundle that is absent or is not a manifest; a missing
  module, a missing program manifest, and a module the store does not have; a file outside `/in/`
  and an oversized bundle; a module the sandbox refuses, and one whose declared memory exceeds the
  cap; a program manifest that does not parse.

Suite: 326 tests, 94 % of lines; lint and the three type-check projects green.

## Why this shape

- Resolution is an effect rather than a synchronous check because the bytes live in the store and
  the core is not allowed to wait. It also means the browser and the seeding path converge: both
  end at `programAdded` with the same four fields.
- The refusal goes to one connection, not to every observer: an upload that failed validation is
  the uploader's business, and broadcasting it would let one person spam everyone's activity list.
- The task cap is checked at spec time rather than at fill time so the execution fails before the
  cluster starts working on a stage it cannot finish.

## Left for later

- The page's side of the upload (presign the blobs, build the bundle manifest, send `launch`) is
  WP2.4, in a parallel worktree.
- Surfacing execution failures and warnings in the dashboard beyond the activity list is WP2.5.
