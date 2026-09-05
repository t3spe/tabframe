# WP9.6 — M9 close: two latent bugs, the comment rule in CI, the records

**Branch** `wp/9.6-m9-close` · **Milestone** M9 · **Date** 2026-09-05 · **Ask** the tail of the plan:
close the milestone with a deploy and three unattended demo passes, and leave the repository with the
rule that keeps history out of its comments.

## Two bugs the refactors surfaced

Both were found by the implementers of WP9.5 while moving code, preserved by them as instructed, and
fixed here with tests.

- **The control plane never learned its image version in production.** It asked the platform about
  itself in the run hook before its core fleet existed, and the lookup went through that fleet, so
  the answer never came: `/health` showed null and cores launched at the image's latest version
  regardless of a rollback pin. The lookup now runs once the fleet exists; a test with a fake fleet
  that describes the MicroVM sees the version on `/health`.
- **A finished retire could come back.** After the rotate function finished the retire a dead run
  had left behind, it kept the pointer it had read at the start, so a later write in the same run
  spread the cleared `retiring` record back into the pointer. The pointer is re-read after the
  clear; the test asserts that no later write names the retired predecessor and that the run ends
  with none.

## The comment rule, kept by CI

`tests/comments.test.ts` scans every source, style, and markup file under `packages/`, `e2e/`, and
`programs/` and fails on a comment line carrying a work-package tag, a date, or the words "used to"
or "found by". The last stragglers outside the refactored files — the page's stylesheet and two
entries, the fleet's pointer codec and its test, one browser test — were cleaned by hand. The link
test moved beside it, so `tests/` holds the two repository-wide checks.

## Records

- `docs/implementation/wp-9.5-structure.md`: the five reviews' findings with what each became.
- The SDK README follows the refactored tooling (the host on the sandbox's `runTask`, the program
  module, `--check`, the new `fs` and `Params` helpers, the ABI files).
- The design record's drift log carries one entry for the milestone.

## Deploy and demo

Three deploys closed the milestone, each `mise run deploy` from a green main: guard, 679 unit
tests, 30 browser tests, the IAM gate (no flag needed), the four stacks, `up`.

| Deploy | Main | Generation | Image | What it carried | Checked by |
|---|---|---|---|---|---|
| 1 | `3d4d02a` | 134 | 27.0 | the whole M9 tree | `mise run demo -- --repeat 3`: three passes, 6.5 min |
| 2 | `4782993` | 138 | 28.0 | the health script fix below | `mise run health`: `/health` and `/diag` 200, build `4782993`, `authoritative: true`, image version `28.0` |
| 3 | `2c3ccd7` | 139 | 29.0 | the handover diagnostic below | `mise run health`: 200/200, build `2c3ccd7`, image version `29.0`; one more demo pass (1.8 min, rotated to 140 inside it) |

**The live deploy caught what no test could.** The refactored health script asked CloudFormation for
a resource named `FleetSecret`; CDK hashes nested logical ids (`FleetSecret09141AA3`), so the first
`mise run health` after deploy 1 failed. The Core stack now outputs `FleetSecretArn` beside
`PointerParameter`, the script reads the output, the resource lookup went (no caller left), and the
synth test pins both outputs. The rotate function, the demo, and the dashboard never touched that
path, which is why the deploy and the three passes were green while the operator's first command was
not.

**A rotation reported `handedOver: false`.** Deploy 2's rotation got 502 from the predecessor on
`/handover` and `/drain`, and the successor adopted the snapshot. The MicroVM API named the cause:
the predecessor was `TERMINATED` with `Resume lifecycle hook connection was refused` — the idle
policy had suspended it (fifteen minutes without traffic after the third demo pass), and the
platform could not resume it for the handover. Its suspend hook had written a snapshot 58 s before
the rotation, and nothing changed in between, so the successor lost nothing (32 executions, 1284
tasks carried). The same 502 appears three earlier times since 2026-09-02: 4 of 41 rotations, all
on a machine nobody was watching; not a regression. The rotate function now fetches the
predecessor's state and reason into its warning (tested), and the runbook has the row.

The MicroVM log group could not help: as the runbook records, a run stream carries only the first
line a process writes. The snapshots in S3 and the MicroVM API were the evidence.
