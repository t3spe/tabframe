# WP4.2 — Operations

**Milestone:** M4 · **Branch:** `wp/4.2-operations` · **Packages:** `packages/control-plane`,
`packages/infra`, `mise.toml`, `docs/runbook.md`

## What

- **`/health` complete.** Beyond the counts: the rotation phase, awake or the reason it is not,
  nodes by kind, every cloud core with its age and whether its node is connected, whether cloud
  cores are enabled, the programs by name, the running execution and queue, ledger sizes, the
  default loop's backoff, the snapshotter's status, uptime.
- **`/diag` complete.** DNS, a **store round trip** (put a probe blob, read it back, report the
  latency — one call that proves credentials, the bucket, and the network), which store driver,
  snapshotter status, memory (RSS and heap), Node version, uptime, and the environment facts that
  matter (`TABFRAME_SANDBOX_WORKER`, cloud cores). Gated by the fleet secret like the other fleet
  routes.
- **Log groups named and kept.** The MicroVM group was already named and kept seven days; the two
  functions' groups had been created by Lambda on first invocation with no retention, so the stack
  cannot own them (*already exists*) — it sets fourteen-day retention on them through CDK's
  `logRetention` instead. The synth test counts the retention provider CDK adds.
- **`docs/runbook.md`**: what is running, the everyday commands, deploy step by step, rollback (pin
  `TABFRAME_IMAGE_VERSION` on the rotate function and rotate), the rotation's paths and failure
  modes, observability, cost and budget, and a table of every incident seen so far with its cause
  and action.
- **Operator tasks:** `mise run health` (both routes through the proxy on the private port, the
  way the fleet reaches them — a one-minute token scoped to 8081 plus the secret, read from the
  rotate function's environment because the secret's ARN is not a stack output), `mise run rotate`,
  `mise run logs` and `logs:fleet`.
- **The budget alarm** is in flight: `tabframe-alarm-test` at one cent, waiting for the account's
  first billing data; Mircea confirms the email (plan WP4.7).

## Two findings

- **The MicroVM platform forwards only a process's first line to CloudWatch.** Every run stream
  holds exactly one event — the control plane's `listening` line — while the process goes on to
  write thousands. Writing the same line to stderr as well delivered the same single line twice
  and nothing more, so it is not a stream choice: delivery stops after boot. The image-build
  streams, by contrast, carry the whole Docker build. Runtime observability is therefore what
  `/health`, `/diag`, the S3 snapshots, and the dashboard say, and the runbook says so. The stderr
  mirror was removed after the measurement.
- **Biome's diagnostic cap failed lint silently.** The `useOptionalChain` warnings that had been
  tolerated since M1 crossed twenty, which turns Biome's exit into an error; `mise run lint` and CI
  both went red on a docs commit. The warnings are resolved (the safe rewrites reviewed by hand and
  by the suite) rather than the cap raised.

## Evidence

`mise run health` against generation 21: `/health` 200 with the fields above (asleep — "ten
minutes with nobody watching" — with `cloudCores: true`, five programs, 32 kept executions,
18,705 tasks, a 2.1 MB gzipped snapshot); `/diag` 200: DNS 4 ms, store put-and-get 122 ms, S3
driver, RSS 312 MiB after seven minutes. Both fleet log groups report a retention of 14 days.
Suite: 455 tests; lint and the three type-check projects green; CI green on the branch.

## Left for later

- The 2.1 MB snapshot is the pacing work package's (WP4.3): 32 kept executions of 640 tasks is
  too many to serialize every five seconds.
- RSS at seven minutes is 312 MiB on a 1 GB MicroVM; with stdout writes going nowhere after boot,
  watch it over an hour — recorded as a check in the runbook's incident table if it climbs.
