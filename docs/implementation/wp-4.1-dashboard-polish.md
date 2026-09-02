# WP4.1 — Dashboard polish

Branch `wp/4.1-dashboard-polish`. Plan: *reassignment flashes, state colors and legend, rotation
banner with countdown and generation, throughput chart, core-count hint on spawn, waking states,
files and ledger panels finished.* The aim is a dashboard that explains itself to a reviewer who
has never seen it: every colour is named, every flash says what moved, every banner says what is
happening and what the visitor can do, and the ledger panel shows what the control plane actually
holds — hashes, not bytes.

## What was delivered

- **Flashes with a log.** A task flashes (white cell on the grid, white outline on the canvas,
  `FLASH_MS` = 1.5 s) on every event that moves it, not only a reassignment: taken back from a
  dead node, given a speculative twin, verified by a duplicate, or retracted after a mismatch. The
  reducer records the kind on the task (`flashKind`) and appends a **pulse** to
  `state.pulses` (capped at `PULSE_CAP` = 12). The page lists the newest six under the legend —
  `t3412 taken back from n2`, `t3388 twin on core-1`, `t3390 verified by n3`,
  `t3395 results disagree, n6 retracted` — each row marked `pulse-live` while its flash is on, so
  the reader can still see what just happened once the cell has stopped blinking.
- **A `released` colour.** Work taken back from a node and waiting for a new one (the scheduler's
  tier one, design §6.3) was indistinguishable from work never handed out. `taskColor` now returns
  `released` (Okabe–Ito orange) for a pending, uncontested task the dashboard saw released; a new
  assignment clears it. Eight task colours plus two overlays, all named in the legend
  (`TASK_COLOR_LABELS` is the single source of the order and the words).
- **Rotation banner with countdown and generation.** `controlPlaneRotating` now raises a banner
  over the stage (`#machineBanner[data-kind="rotating"]`) naming the next generation and counting
  down to the reconnect from the event's `reconnectAfterMs` against the page clock
  (`rotationCountdown`); the text says what a rotation is and that there is nothing to do. When
  the observer socket then closes with the rotating code, the full-page banner says *Control plane
  rotating…* but **keeps the canvas and the node table on screen**, so the render visibly
  continues into the new generation. The header gains a `rotation in N min` pill from the
  snapshot's `nextRotationAt`.
- **Sleep and waking states.** `machineSleeping` and a snapshot with `awake: false` raise the same
  banner in its `sleeping` / `asleep` kinds, with the core's own reason, what the machine does
  about it, and how it wakes. The connection-level banner (`#banner[data-state]`) covers `off`,
  `starting` (now worded as *Waking the machine…*), `connecting`, and `outdated`, each with a
  title, a body, and a hint line for the visitor. All of this copy lives in `banners.ts`, pure and
  unit-tested.
- **Throughput chart.** A 240×36 canvas in the execution row draws tasks done per second over the
  last minute (`throughputSeries` over a 60 s `doneLog` of `taskDone` arrival times, design §6.7);
  the figure beside it reads `3.2 tiles/s · 5 nodes`. Small, and it goes quiet with the cluster.
- **Core-count hint on spawn.** The "Your nodes" panel says how many cores this browser reports
  (`navigator.hardwareConcurrency`), that *spawn N* keeps one for the page, and that spawning more
  than that only slices the same cores thinner; the button's tooltip says the same.
- **Ledger panel.** A new aside section lists the newest eight settled tasks of the current stage:
  task id (✓ when a twin verified it), the node that computed it, the output hash (full hash in the
  tooltip), the size (w × h × 4 for placed tiles, else from the folded manifest once it is
  fetched), and where the bytes live — a link to `<store>/<hash>` on the real machine, *demo
  store* in the demo. Its note says in words what the architecture rests on: the control
  plane keeps a 64-hex hash per task and nothing else. The files panel got a one-line explainer of
  manifests and roots.
- **Demo story extended.** After the broken program fails, the demo machine goes to sleep (the
  core's reason wording, *an hour without anyone touching the dashboard*) and wakes for the next
  frame with a snapshot; `?program=broken&hold=1` therefore holds on the sleep banner. The rotation
  at tile 520 already existed; `?pause=520` holds on the rotation banner with its countdown frozen
  at 2.4 s because the demo's clock stops with the pause. Twins, verifications, the retraction, and
  kill-half's releases all leave pulses, so every new element is exercised in the demo.

## How it works

State stays pure and the page stays glue, as in WP1.8 and WP2.5:

- `state.ts` — `FlashKind`, `Pulse`, `TaskState.flashKind / released / settledAt`,
  `ClusterState.doneLog / pulses`, the `released` colour in `taskColor`, `TASK_COLOR_LABELS`,
  `throughputSeries`, `rotationCountdown`, `machineBanner` (rotation wins over sleep, sleep over the
  snapshot's asleep flag; the first snapshot page clears both, as before), and `ledgerRows` (newest
  settled first, by `settledAt`). A `taskDone` from a node the dashboard never saw take the task is
  now recorded as a `done` attempt, so the ledger can name the winner.
- `banners.ts` — `connectionCopy(state, detail)` and `machineCopy(banner)`: title, body, hint.
- `panels.ts` — `renderLedger`, signature-gated like the other panels; `PanelDeps.storeBase()` for
  the link target.
- `host.ts` — the legend from `TASK_COLOR_LABELS`, `renderMachineBanner`, `renderChart`,
  `renderPulses` (rebuilt only when the list or the live set changes, so the CSS animation runs
  once per new pulse), the spawn hint, and `setMachine` placing the connection copy. The old
  `#notice` line now carries only the transient *not connected* message, cleared after 4 s.
- `demo.ts` — `asleep`, the sleep event after the broken program, the wake snapshot in
  `startNext`.

## Why

- A **log of flashes** rather than only the animation: a flash lasts 1.5 s, the reviewer's eye is
  elsewhere, and a video pauses. The words stay; the animation is the pointer.
- **Released as its own colour**: the reassignment story (tier one, oldest first) is the heart of
  the fault tolerance; without the colour the grid shows a dead node's work as if nothing happened.
- **Banners over notices**: the notice line was one sentence in the header's colour; a rotation
  or a sleep is the moment a reviewer is most likely to think something broke, so it gets a box,
  a countdown, and an explicit *nothing to do*.
- **Keeping the picture during the reconnect**: the design's promise is that the render continues
  across a rotation (§9.4); hiding the canvas for the reconnect delay contradicted it on screen.
- **Ledger panel**: the hashes-not-bytes claim was implicit everywhere and stated nowhere on the
  page.

## Evidence

- `bun test`: all suites green, including the new
  `packages/web/src/state.test.ts` cases (flash kinds and pulses, the legend's order, the chart's
  buckets and pruning, the countdown and banner selection, the ledger's rows) and
  `packages/web/src/banners.test.ts`.
- `bunx playwright test`: 18 browser tests, the 15 existing plus `e2e/polish.e2e.ts` — the legend,
  the pulse log, the throughput figure, the spawn hint, the ledger rows at `pause=300`; the
  rotation banner, generation, and countdown at `pause=520`; the sleep banner on
  `program=broken&hold=1`. Every assertion is on a class, attribute, or text in a paused demo, never
  on the timing of a live render.
- Screenshots (`packages/web/scripts/screenshot.ts --demo --pause N`):
  - [`assets/wp-4.1/rotation-banner.png`](assets/wp-4.1/rotation-banner.png) — the rotation
    banner over a frame at tile 520: generation 8, countdown 2.4 s, the legend, the chart, the
    pulse log, and the ledger.
  - [`assets/wp-4.1/dashboard.png`](assets/wp-4.1/dashboard.png) — the frame at tile 300 after
    kill-half: released tiles in orange, the pulse log naming what was taken back, the ledger's
    eight newest hashes.

## Stable hooks for the unattended demo (WP4.4)

| Element | Hook |
|---|---|
| Machine banner (rotation, sleeping, asleep) | `#machineBanner[data-kind="rotating" \| "sleeping" \| "asleep"]`, `data-next` on a rotation |
| Rotation generation and countdown | `#rotationGeneration`, `#rotationCountdown` (text `N.N s`) |
| Next rotation pill | `#nextRotation` (`rotation in N min`; hidden when unknown) |
| Connection banner | `#banner[data-state="connecting" \| "starting" \| "off" \| "outdated"]`, `#bannerTitle`, `#bannerBody`, `#bannerHint` |
| Legend | `#legend .legend-item[data-state="<colour>" \| "flash" \| "contested"]`, colours `pending assigned speculated released done verified mismatch failed` |
| Pulse log | `#pulses li[data-kind="released" \| "speculated" \| "verified" \| "mismatch"][data-task]`, class `pulse-live` while flashing; the full list at `window.tabframe.state.pulses` |
| Throughput | `#throughputChart`, `#throughputFigure[data-rate][data-nodes][data-peak]`; header pill `#rate` unchanged |
| Spawn hint | `#spawnHint[data-cores][data-default]`, `#spawnCount` |
| Ledger | `#ledgerPanel`, `#ledgerNote`, `#ledger tbody tr[data-task][data-hash][data-size]` |
| Files explainer | `#filesNote` |
| Task state | `window.tabframe.state.tasks.get(id).flashKind / released / settledAt` |

Existing hooks are unchanged: `body[data-demo-paused]`, `window.tabframe`, `#exec`, `#gen`,
`#counts`, `[data-counter]`, `#tileStats`, `#activity`, `#nodes tbody tr[data-node-id]`.

## Drift

- Flashes were specified for reassignments (design §6.7); they now cover twins, verifications, and
  retractions too, with a colour for released work and a log of pulses. Rotation and sleep moved
  from the notice line to a banner with a countdown, and the canvas stays up through the reconnect.
  The ledger panel is new. Recorded in the design's drift log.

## Open items

- The ledger names sizes only for placed tiles and for outputs the folded manifest already
  describes; a mid-stage `bars` or `text` output shows `—` until its stage folds.
- `#notice` is now only the transient *not connected* line; a sequence gap is still handled
  silently by the client's resubscribe.
- The connection banner's `starting` state cannot be produced against the local control plane, so
  its copy is unit-tested rather than browser-tested.
