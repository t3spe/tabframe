# WP6.8 — The review fixes

**Branch** `wp/6.8-review-fixes` · **Milestone** M6 · **Date** 2026-09-03 · **Ask** Mircea's review
of the deployed M6 dashboard (2026-09-03, with a screenshot at generation 77): 1) no Stop button
in sight; 2) overlapping elements at the top of the page; 3) file names should open the file in the
browser; 4) the ledger must not truncate the output hash or the store address; 5) a way to pause the
ledger to inspect it; 6) the looping is unpleasant and it steals the focus from a person who is
trying to do something — "whoever is going to review this is going to get frustrated and overwhelmed
quickly".

## What changed

- **Stop is in the header at all times (1, 6).** A red Stop sits beside the pills in the header of
  every dashboard; it swaps for Start while the machine is stopped or the loop has yielded, and a
  Resume shows while the editor tab holds the machine paused. Before, Stop lived in the controls
  panel below the picture, where the screenshot never reached.
- **The loop yields to people (6).** Core: `meta.loopYielded` is set when a person's launch ends —
  done, failed, or killed. While it is set the loop launches nothing: no new frame from the default
  loop and no queued continuation, so the person's result stays on the stage. It clears when Start
  is pressed or when nobody has interacted with the machine for ten minutes (`YIELD_IDLE_MS`;
  interactions are controls, launches, and subscribes), after which the loop resumes by itself, so
  an abandoned tab still renders. This replaces WP4.4's twenty-second hold, which let the loop take
  the stage back while the person was still looking (`loopPausedUntil` stays for the backoff after a
  failed frame). The machine view carries `yielded`; the execution pill reads "loop yielded to you"
  and the header shows Start. Snapshots carry the flag; old snapshots read it as false.
- **The top of the page (2).** One status line, a single line high, holds the machine banner or
  the notice. Under it the execution row is a fixed grid — name and detail, the progress bar and its
  figure, the throughput chart — and the three messages that used to stack (failure, warnings,
  follow-up) share one reserved slot. Hidden header buttons are really hidden (`display: none`
  under `[hidden]`), so nothing overlaps and nothing moves when a message comes or goes.
- **Whole hashes and addresses in the ledger (4).** The output hash and the store address wrap
  instead of being cut (`overflow-wrap: anywhere`); the address is a link to the raw bytes.
- **Freeze on the panel tabs (5).** The ledger, files, and activity tabs get a *freeze updates*
  button that holds the page's rendering while you read; it counts the updates held ("resume
  updates (N held)") and catches up on release. It pauses the page, not the machine; the machine's
  own pause stays the editor tab's.
- **Files open in the browser (3).** Every file name in the files panel is a link to the viewer
  tab (`?observe&panel=files&root=…&file=…&path=…&size=…`), which opens with that file selected and
  offers "raw bytes ↗" at the store address. The stages' roots are offered for browsing an earlier
  filesystem. The link — like the panels' "open ↗" links — carries the page's own query, so a demo
  opens the same demo and a live page opens an observer; the viewer keeps its pinned file across
  executions until the reader browses elsewhere (the first draft lost it on the tab's first frame,
  which the browser test caught).

## Tests

- `packages/core/src/loop.test.ts`: after a person's launch ends the loop stays out — the queued
  continuation waits — until Start; ten idle minutes (after a control refreshed the interaction
  time) bring it back by themselves; Stop cancels the running frame and the automatic queue, keeps a
  person's queued launch, and the snapshot says `stopped`; Start relaunches at once.
- `packages/core/sim`: the chaos observers press Stop (weight 0.3) and Start (when the machine is
  stopped or the loop has yielded) among their controls. The calm phase owes the loop its yield —
  the settle deadline moves past the ten idle minutes while the loop is yielded — and the last person
  presses Start when the machine is stopped (a stopped machine never moves again by itself) and, in
  half the runs, when it has yielded; the other half prove the ten-minute resume. Start is pressed a
  beat after the resume (one control a second per observer) and again every two seconds until it
  lands.
- `e2e/panels.e2e.ts`: the ledger tab shows the whole output hash and store address and the freeze
  button holds its rows; a file name is a link to the viewer tab, which opens on that file.
- `e2e/demo.e2e.ts`: after the tiny GPT beat the pill reads "loop yielded to you" and Start is
  visible; pressing it brings Mandelbrot back. The layout probes (WP6.2) run at every beat and pass
  with the new top of the page.

## Drift

`docs/design.md` §6.7 (Stop, Start, the yield, the header), §8.3 (the controls list and the machine
view), §17 entry of 2026-09-03 (WP6.8).
