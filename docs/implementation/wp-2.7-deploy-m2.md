# WP2.7 — Deploy M2

**Milestone:** M2 · **Branch:** `wp/2.7-deploy-m2` · **Packages:** `packages/control-plane`,
`packages/infra`

## What

M2 on the real machine, and the runbook that proves it: `mise run verify:m2`
(`packages/infra/scripts/verify-m2.ts`). It opens tabs on the deployed page, edits the Mandelbrot
source in the in-page editor, compiles it in the browser, launches it, runs word count from the
programs panel, and finishes with a trapping planner. `docs/m2-verification.md` has the table:
seven checks, none failed.

The deploy itself was a **rotation** — `mise run up` handed over from generation 13 to 14 rather
than replacing the machine, which is what the design means by "deploys are rotations".

## The fix the deploy found: seeding must be idempotent

A control plane that adopted its predecessor's ledger skipped seeding entirely (`if
(target.programs.size > 0) return`). Word count shipped in the image and never appeared, because
every generation since it was added had adopted a ledger seeded before it existed. Seeding now
computes each shipped program's bundle hash and adds the ones the ledger does not have; a bundle
already there is left alone, and the default loop is only set when there is none. That is also what
makes a deploy-as-rotation able to deliver a new program at all.

`packages/control-plane/src/adopt.test.ts` gains a case: a first machine seeds one program and
hands its ledger on; the second ships two and adopts that ledger; both programs are present
afterwards and the adopted one is not added twice.

## Three things about running a browser runbook against a live machine

- **Close the browser on every exit path.** Three runs failed with "the page was not live" because
  earlier killed runs had left headless Chromium processes lending nodes. Those sockets count
  against the MicroVM endpoint's concurrency budget (WP3.5), so a new page could not open its
  observer socket at all. The runbook now closes the browser on `SIGINT`, `SIGTERM`, an uncaught
  exception, and an unhandled rejection.
- **A person kills what is running before launching.** A human launch goes ahead of automatic
  continuations but does not preempt the execution in flight, so the runbook clicks
  `killExecution` first — which is what a reviewer would do, and what makes the run take ninety
  seconds instead of five minutes.
- **The programs panel's row opens a form; the form's button launches.** `data-launch` then
  `data-launch-go`, the same pair the browser suite uses.

## Evidence

`docs/m2-verification.md`. Suite: 451 tests; lint and the three type-check projects green; 15
browser tests pass locally.

## Left for later

- The runbook reads word count's answer from the execution's filesystem root (`/out/2/0`), which
  also exercises the files panel's data path; a dashboard assertion on the bars view itself is
  covered by the browser suite against the demo.
