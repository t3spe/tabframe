# WP2.1 — Filesystem complete

**Milestone:** M2 · **Branch:** `wp/2.1-filesystem` · **Packages:** `packages/core`,
`packages/protocol`, `packages/control-plane`, `packages/web`

## What

The execution filesystem of design §5.4, finished. Write buffering, the own-writes overlay,
`list`/`stat`, and the per-task caps landed with the sandbox (WP1.4); upload and commit-on-
acceptance with the node (WP1.6); conflict detection at fold and result identity including writes
with the scheduler (WP1.2). This work package closes the rest:

- **An execution starts from its bundle's files.** A `ProgramRecord` now carries the bundle's
  files — the module, the manifest, and anything under `/in/` — and `enqueue` seeds
  `exec.files` from them. Because a bundle *is* a filesystem manifest blob, the bundle hash is
  the first root: no extra blob, and the first stage's tasks are assigned with `fsRoot = bundle`,
  so a program can read `/in/corpus.txt` in stage 0. Seeded and uploaded bundles take the same
  path; the control plane passes the files it computed at seeding into `programAdded`.
- **Inheritance.** `persist` programs inherit the latest finished run of themselves without being
  asked (D5); any launch may still name an execution or `latest` explicitly, and naming one that
  never finished is refused. The inherited filesystem is merged with the bundle's files, and the
  bundle wins on conflicts, so a relaunched bundle's inputs and module are never shadowed by stale
  copies. The merged manifest is stored and its hash becomes the execution's initial root.
- **Expired-root fallback.** Blobs are kept a year and then go. Before planning, an execution that
  inherits fetches the inherited root; if it is gone the execution starts from the bundle alone
  and the observers get a new `executionWarning` event with code `expired-root` — visible, not
  fatal, because the program can still run. The dashboard prints it in the activity list.
  Checking the root blob stands for checking the whole filesystem: blobs of one execution expire
  together, and fetching every file to find out would cost more than it tells.
- **Per-execution filesystem cap.** `ledger.config.fsBytesCap` (256 MB by default) is checked at
  each fold; over it, the execution fails with both numbers in the message.

## Wire and event changes

- `executionWarning { executionId, code, message }` on the observer socket.
- `programAdded` (the internal event, not the observer one) carries the bundle's `files`.
- Blob purposes gain `inheritRoot`, and `manifest` accepts stage `-1` for an execution's initial
  filesystem.
- A snapshot written before this change has program records without files; deserialization
  defaults them to empty.

## Tests

`packages/core/src/filesystem.test.ts`, nine cases: the bundle is the first root and no blob is
stored for it; outputs land at `/out/<stage>/<index>` beside the bundle's files; writes land at
their own paths and are visible to the next stage; a write conflict fails the execution while
identical bytes are fine; the size cap fails with both numbers; a `persist` program inherits
without being asked and its merged manifest carries the earlier run's writes, outputs, and the
bundle's inputs; a non-persist program does not; an expired root warns and starts from the
bundle; inheriting from an execution that never finished is refused. Every case ends with the
invariant check.

Suite: 311 tests, 94 % of lines; lint and the three type-check projects green.

## Why this shape

- Making the bundle hash the first root removes a round trip and a failure mode from the common
  case (nothing inherited), and it is only true because a bundle and a filesystem are the same
  shape — which is itself the reason bundles were defined that way.
- The expired-root check happens at start rather than at first read, so the warning arrives before
  any task has burned compute, and the tasks that follow see a root that exists.
- The cap lives at fold rather than at write time: a task cannot know the whole filesystem, and
  failing after the stage is the first moment the number is real.

## Left for later

- Per-execution *task* caps and compute budgets are WP2.3, with the rest of the launch path.
- The dashboard's files panel (browse an execution's filesystem by root) is WP2.5; the execution
  view already carries the root hash it needs.
