# WP6.7 — The rotation observations

**Branch** `wp/6.5-transformer` (with WP6.5) · **Milestone** M6 · **Date** 2026-09-03 · **Ask**
Batch A item 7: one focused block on (a) the brief "asleep" banner at the start of a rotation and
(c) a rotation's successor being a half-hour-old MicroVM

## What was found

- **A plain rotation is clean.** `packages/infra/scripts/rotation-probe-busy.ts` opens two real
  dashboards with spawned nodes, samples the page-visible machine state four times a second, and
  invokes the rotate function: the rotating banner shows with its countdown, the page reconnects to
  the next generation within two seconds, the render continues from the adopted ledger, and the
  machine reads awake with no reason throughout. No "asleep" banner.
- **The cause was the repair path.** When the rotate function finds a *pending* successor left by
  an interrupted rotation, it used to *promote* it — flip the pointer to it — without a handover.
  A pending successor has only the snapshot it booted from, minutes or more old, and has been
  sitting with it, asleep, since; the page reconnecting to it saw an old machine ("ten minutes with
  nobody watching") until the successor noticed its observers, and `/health` showed a control plane
  whose process was half an hour old. Pending successors were left behind by the hourly rule
  racing the demo's manual rotations.
- **Two fixes in the rotate function.** A pending successor is terminated and forgotten while the
  current control plane still serves, and the rotation starts afresh from the live ledger; it is
  promoted only when nothing else is serving (the crash case it was for). And a *scheduled*
  invocation (the hourly rule, `source: aws.events`) within five minutes of the last pointer change
  is skipped as `skipped-recent`; an operator's `mise run rotate` never is.

## Tests

- `packages/fleet/test/rotate.test.ts`: a stale pending successor is terminated while the current
  control plane serves and a fresh rotation follows; a pending successor is still promoted when
  nothing else serves; a scheduled rotation minutes after the last is skipped while a manual one
  proceeds.

## Drift

- Design §9.4: the repair rule (promote only when nothing serves) and the five-minute guard on the
  hourly rule. Runbook rows updated.
