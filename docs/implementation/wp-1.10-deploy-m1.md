# WP1.10 — Deploy M1

**Milestone:** M1 · **Branch:** `wp/1.10-deploy-m1` · **Packages:** `packages/store`,
`packages/core`, `packages/infra` (runbook), `playwright.config.ts`

## What

M1 on the real machine: the image now ships the compiled demo programs, the control plane seeds
them at boot, and browser tabs render a Mandelbrot frame that matches the goldens tile for tile
while half the cluster is killed underneath them. `docs/m1-verification.md` has the table.

Getting there took four fixes, each found by running the thing rather than by reading it.

- **The presigned PUT must sign the checksum header.** Tab uploads failed with 403 and
  *"headers present in the request which were not signed: x-amz-checksum-sha256"*. The v3 signer
  hoists `x-amz-checksum-sha256` into the query string, so a client that sends it as a header is
  refused; a client that omits it succeeds, and then S3 **ignores the pin** — a probe against the
  real bucket uploaded bytes that did not match the key and got a 200. `S3Store.presign` now
  passes `signableHeaders` and `unhoistableHeaders` for the checksum and refuses to hand out a URL
  whose signature does not cover it, and `signedHeaders` returns exactly the signed set and
  nothing more. Correct bytes: 200. Tampered bytes: 400 `BadDigest`. Both verified against the
  bucket; the unit test asserts the checksum is in `X-Amz-SignedHeaders` and absent from the
  query.
- **A failing default loop must back off.** With uploads failing, the machine relaunched about ten
  executions a second. `failExecution` now pauses the loop — `LOOP_BACKOFF_MIN_MS` five seconds,
  doubling to `LOOP_BACKOFF_MAX_MS` five minutes — and a successful execution resets it. Human
  launches never touch the backoff, and a released result (a node giving up) is not a failure.
- **The ledger must stay bounded.** `pruneExecutions` drops ended executions beyond the most
  recent 32 together with their tasks, on every tick. Results live in the store by hash and a
  continuation copies what it inherits at enqueue, so nothing live points at what is pruned. This
  also bounds the snapshot.
- **Browser suites run against an idle machine.** `playwright.config.ts` sets an empty programs
  directory, so the local control plane the tests start does not seed and launch its loop under
  them.

**The runbook**, `mise run verify:m1` (`packages/infra/scripts/verify-m1.ts`): reads the stack
outputs, fetches a session, opens an observer socket through the MicroVM proxy, opens three real
browser tabs on the deployed page, launches the golden frame itself (a human launch goes ahead of
the machine's own loop, so the run is comparable whatever the machine was doing), kills half the
cluster at a configurable tile count, waits for the execution to end, and checks: every tile
settled, the multiset of tile hashes equals the goldens (the frame repeats tiles in flat regions,
so a set comparison undercounts), no task failed, a tile reads back through CloudFront with its
hash, `latest.json.gz` is fresh under the current generation prefix, and the machine returns to
its default loop. Flags: `--tabs`, `--kill-at`, `--timeout`.

## Evidence

- `docs/m1-verification.md`: nine checks passed, none failed, on generation 3.
- 640 of 640 tiles match goldens produced on a different runtime (Node) on a different machine.
- Suite: 302 tests, 94 % of lines; five Playwright tests; lint and the three type-check projects
  green.

## Why this shape

- The runbook launches its own frame rather than watching whatever the loop is doing: the goldens
  are for one parameter set, and the machine advances presets every frame.
- The kill happens at a tile count rather than a wall-clock time, so it always lands mid-frame
  whatever the cluster's speed.
- Backoff lives in the core, not in the process: the simulation and the tests see the same
  behaviour the deployed machine has.

## Left for later

- Cloud cores (M3) are not in this run; the fleet launches only the control plane.
- The MicroVM log group still shows no events (tracked for M4); the runbook reads the machine
  through its own sockets and S3 instead.
