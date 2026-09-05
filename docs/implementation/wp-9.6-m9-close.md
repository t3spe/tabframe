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

DEPLOY_DEMO
