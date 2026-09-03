# WP6.4 — The editor in its own tab, and pausing

**Branch** `wp/6.4-editor-tab-pause` · **Milestone** M6 · **Date** 2026-09-03 · **Ask** "entering
editor mode should be done in a separate tab and it should also pause the current execution"

## What changed

- **The editor is a page of its own**, `editor.html` with `editor-page.js`: the same editor
  (compiler worker, drop door, manifest and params form, launch) mounted on its own observer
  socket. The dashboard's button opens it in a new tab (a named target, so a second click reuses
  the tab); the in-page overlay is gone. The stylesheet moved out of `index.html` into
  `styles.css`, which both pages load.
- **Pause and resume**, two observer controls distinct from Stop. `pause` makes the sender the
  holder (`meta.pausedBy`): the scheduler assigns nothing new, no queued execution starts, the loop
  launches nothing; in-flight tasks finish and their results land, so a stage still folds and the
  next stage's plan is created but waits. `resume` from anyone lifts it — and so does the holder's
  socket going away, in the control plane itself. A pause never survives a snapshot restore or a
  rotation: the holder's socket belongs to the previous generation. Asking twice from one socket is
  one pause.
- The editor tab sends `pause` every time its socket comes live (a reconnect is a new holder),
  `resume` when a launch is sent (that is what the pause was for), when the close button is pressed
  (then the tab closes itself), and on `pagehide` as a courtesy. The tab says what it does and that
  it is one of the endpoint's sixteen connections.
- The dashboard shows "paused (editor open)" on the execution pill and a **Resume** button while a
  pause holds; the control's echo flips the state, the snapshot carries `machine.paused`.
- An execution ended by Stop shows the phase **stopped**, not failed: no failure banner, a neutral
  pill.

## Tests

- `packages/core/src/loop.test.ts`: pause freezes assignment and starts while a plan result still
  lands and the stage is created; a second pause from the same socket is silent; the snapshot says
  paused; resume hands the tiles out at once; the holder's disconnect resumes and relaunches the
  loop; a restore and an adoption both clear the pause.
- Protocol round trips; the reducer flips `machine.paused` on the echoes.
- `e2e/editor.e2e.ts`: the dashboard's button opens the editor tab, the dashboard reads paused and
  offers Resume, closing the tab lifts the pause, Resume from the dashboard works while a tab holds
  it. The editor, sandbox, panels, and money-shot suites drive the editor page; the demo's editor
  beat opens the tab, sees the pause, launches, sees it lifted.

## Drift

- Design §3: two pages, the dashboard and the editor; §6.7: pause/resume beside the other controls;
  §5.6: the editor's pause. `Meta.pausedBy`, `MachineView.paused`, controls `pause`/`resume`,
  `Phase` gains `stopped` on the dashboard.
