# WP7.1 — Stop, Start, and the loop pill

**Branch** `wp/7.1-stop-start-loop-pill` · **Milestone** M7 · **Date** 2026-09-03 · **Ask** Mircea's
third review, items 1 and 4: "what does Stop actually do?" and "if I launch a program I see it
running while I see Start on the right". Decision D1 (recommended): Stop ends what runs and holds
the automatic loop; a person's launch still runs at once.

## What changed

- **The header's one slot means "what you can do to the machine right now".** `headerSlot()` in
  `packages/web/src/state.ts`: Resume while an editor tab holds the machine; Stop while anything
  runs (the loop's frame or a person's launch); Start when nothing runs and the loop is held by
  Stop or has yielded; Stop again when the loop is free, to hold it before its next frame. Before,
  the slot followed only the loop's flags, so Start stood beside a running launch.
- **The loop has its own pill.** `#loop` beside the execution pill says "loop · running", "loop ·
  held by Stop", "loop · yielded to you", or "loop · paused by the editor", amber whenever a
  person holds it, with a tooltip that says what changes it. The execution pill is about the
  execution only; the "· stopped", "· loop yielded to you", "· paused (editor open)" suffixes are
  gone from it.
- **Stop says what it will do, then what it did (rule R2).** Stop's tooltip names the execution it
  would end ("Ends wordcount e7 (a person's launch) and holds the automatic loop until Start; a
  launch of yours still runs at once"), or, when idle, that it holds the loop before its next frame.
  The activity line for the echo reads "stop: e7 ended, the loop is held until Start; a launch
  still runs at once" / "start: the loop runs again" / "pause: an editor tab holds the machine…" /
  "resume: the editor's pause is lifted". A control this page issued shows its echoed line in the
  notice for five seconds (`noticeOwnControl`), which every control in the header and the controls
  panel now gets for free.

## Tests

- `packages/web/src/state.test.ts`: `loopState` precedence (paused > held > yielded > running);
  `headerSlot` for every phase (planning, running, folding, done, failed, stopped, none) × every
  loop state; `stopTitle`; the activity lines for stop and start.
- `e2e/dashboard.e2e.ts` (live): after Stop the execution pill reads "idle", the loop pill "loop ·
  held by Stop", the notice says what happened; after Start the loop pill reads "loop · running".
- `e2e/editor.e2e.ts`, `e2e/demo.e2e.ts`: the pause and the yield are read from the loop pill.
  The demo's word count beat records, at every poll, which of Stop / Start / Resume is shown and
  asserts Stop while the person's launch runs and Start once it is done and the loop has yielded.

## Drift

`docs/design.md` §8.3 (the header's slot and the loop pill), §17 entry of 2026-09-03 (WP7.1).
