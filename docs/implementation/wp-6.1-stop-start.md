# WP6.1 — Stop and Start from the page

**Branch** `wp/6.1-stop-start` · **Milestone** M6 · **Date** 2026-09-02 · **Ask** "give me a way to
stop the currently running program from the UI"

## Why

The page could kill an execution, skip it, or restart it, but the loop launched the next frame
within a tick (or after the twenty-second hold): there was no way to make the machine *idle* and
keep it that way.

## What changed

- Two observer controls, **`stop`** and **`start`** (protocol `observerToControlPlane`;
  `controlApplied.op` gains both). Stop ends the running execution ("stopped by a person"), cancels
  the loop's queued continuations — a person's own queued launches stay and run — and sets
  `meta.loopStopped`, which survives snapshots and rotations. While it is set, `ensureDefaultLoop`
  launches nothing, `maybeStart` starts no automatic execution, and a finished loop frame offers
  no follow-up. Start clears the flag along with any hold or backoff, so the loop launches on the
  spot.
- The snapshot's `machine` view carries `stopped`. The dashboard swaps one button for the other
  (Stop while the loop may run, Start once a person stopped it), the execution pill reads
  "idle · stopped by a person" or "… · stopped", and the control's echo flips the state without
  waiting for a snapshot.
- The unattended demo gains a beat: stop, watch the pill stay stopped for eight seconds, start,
  watch a frame begin.

## Tests

- `packages/core/src/loop.test.ts`: stop ends the running frame, drops the loop's queued
  continuation, keeps a person's queued launch (which runs) and holds the loop through thirty
  ticks after it ends; the snapshot and a serialize/deserialize round trip carry the flag; start
  launches at once, hold or backoff notwithstanding; stop with nothing running is just the hold and
  a person's launch still runs.
- Protocol round trips for the two controls and the two echoes; a dashboard reducer test; the live
  dashboard suite clicks Stop, reloads (the snapshot carries it), and clicks Start.

## Drift

- Design §6.7 gains Stop/Start beside the other controls; §6.8's loop honours `loopStopped`.
- `Meta.loopStopped`, `MachineView.stopped`, controls `stop`/`start`.
