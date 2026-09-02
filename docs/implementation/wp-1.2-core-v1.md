# WP1.2 — Core v1: the scheduler

**Milestone:** M1 · **Branch:** `wp/1.2-core-v1` · **Merged:** 2026-09-02

## What

The control plane's logic as design §6 describes it, still a pure function over the ledger:

- **Ledger v1** (§6.2): programs, executions (status, stage, filesystem root and files, compute
  samples and budget, follow-up, inheritance, counters), tasks (inline input, placement, attempts
  with deadlines and outcomes, collected results, the accepted result, contested rounds,
  required agreement), plus the queue and the running execution.
- **Fill** (§6.3): released work first, then pending work in stage order, then speculative twins
  for overdue attempts; round-robin across nodes so work spreads before any node fills up; every
  assign carries the ABI fields the node needs and is announced as `taskAssigned` or
  `taskSpeculated`.
- **Liveness and release** (§6.4): a node declared gone releases its attempts; a task whose only
  attempt was released drops back to the front as `released`, announced as `taskReassigned`.
  Deadlines are three times the rolling median compute time of the execution, floored at 2 s.
- **Results and verification** (§6.5, D7): a result's identity is its output hash plus its sorted
  write list; the first result settles a task, or two agreeing ones with the redundancy toggle;
  a twin's late result verifies (`taskVerified`); a disagreeing result contests the task —
  retracted if it was painted, sent back to the front, recomputed — and after two contested
  rounds the majority identity across all results wins and the tile is flagged as resolved by
  vote. A trap is a result carrying an error; it fails the task and the execution.
- **Execution lifecycle** (§5.2, §6.6): launch validates the program and queues the execution
  (human ahead of automatic); the first act is a `plan` task with frozen hints; the planner's
  spec is fetched from the store (an effect) and materialized as run tasks with placements; when
  a stage's last task lands the outputs and writes fold into a new filesystem manifest (conflicts
  fail the execution), the manifest is stored (an effect), the root advances, and the next plan
  task goes out; `done` finishes the execution and, for the default loop only, queues the
  continuation that inherits the root (D19).
- **Controls** (§6.7): kill, freeze, and throttle half with the injected random source, resume,
  restart, skip, kill execution, launch, run follow-up, set redundancy; each announced with
  `controlApplied`. Health relabels fast and slow against the cluster median.
- **Snapshots** (§8.3, §9.4): paged observer snapshots with the cluster on page 0; ledger
  serialization for S3 and handover; `adopt` releases every attempt and clears nodes.
- **`checkInvariants`**: design §6.10 as a function the tests and the simulation call after every
  event.

## How

- New effects let the core stay pure: `fetchBlob` (a stage spec), `putBlob` (a manifest),
  `presign` (answered by the process from the store driver). The matching events `blobFetched`
  and `blobStored` bring the results back.
- The test harness (`harness.ts`) drives `apply` with the wire messages nodes and observers send,
  on virtual time with a seeded random source, and answers store effects; the churn simulation
  (WP1.9) will reuse it.
- `wanted(task)` is the one function that decides whether a slot may take a task: required
  agreement minus results this round minus running attempts; speculation is the case where
  nothing is wanted but the single attempt is overdue.

## Why

- **Tiers, not priorities** (§6.3): the same routine decides every assignment; speculation falls
  out as the lowest tier, which is exactly when stragglers hurt.
- **Identity over reference**: results are compared by content identity, so a ledger restored
  from JSON judges duplicates the same way a live one does.
- **Executions end cleanly**: an ended execution settles its open tasks as failed, so the ledger
  never holds work that nothing will ever finish.

## Evidence

- `bun test`: 35 core tests covering fill and refill, fold and finish, released-first ordering
  after a death, silence releasing like a close, twins only when nothing is pending with first
  result winning and the twin cancelled, deadlines from the floor to three times the median,
  contested tiles retracted and voted on, redundancy needing two agreeing results, traps failing
  the execution, write conflicts, queue ordering and the default loop, kill/throttle/resume,
  skip and restart, control refusals, paged snapshots, ledger serialization and adoption, and the
  invariants checker catching a broken ledger. Every test asserts the invariants afterwards.
- Coverage on the core above 90 % of lines; `mise run lint` clean.

## Dependencies introduced

None.

## Drift

- `result` carries `outputSize`, which the filesystem manifest needs (protocol §8.2).
- Fill is round-robin across nodes rather than node by node; the design's tiers are unchanged.

## Open

- The process executes `fetchBlob`, `putBlob`, and `presign` from WP1.3/WP1.7 on; until then it
  logs them.
