# WP4.4 — The unattended demo

**Branch** `wp/4.4-demo` · **Milestone** M4 · **Date** 2026-09-02

## What

`e2e/demo.e2e.ts` runs the demo script of design §13 against the deployed machine, in the order
the video follows, with no one at the keyboard: one tab and the two cloud cores the machine
launches for it → two more tabs → spawn ten (bounded by what the browser reports, said on screen)
→ kill half → freeze half → throttle half (twins, then resume) → redundancy on (verified tiles,
zero mismatches) → the editor: change the palette cycle, compile in the browser, launch under a
name of its own → word count: three stages and the bar chart → a rotation started while the page
watches: banner, new generation, the picture stays, the machine keeps working → the ledger and
files panels. Every beat is an assertion on the stable hooks WP4.1 gave the page.

`mise run demo [-- --repeat 3] [--video]` resolves the web origin from the `TabframeCore` stack and
runs the suite; `--video` records the browser (WP5.3's fallback footage). The suite skips itself
without `TABFRAME_URL`: it wants the seeded programs, cloud cores, and a real rotation, none of which
the Playwright control plane in CI has. The rotation is the fleet script (`mise run rotate`) run in
the background, so the browser tests carry no AWS SDK.

## What the first runs found

- **A killed core stayed dead and unlinked for ever.** `kill half` had picked a cloud core; the
  node closed "for good" (a closed node never reconnects, by design), but the MicroVM stayed
  `RUNNING` with a live server and no node, and the fleet policy — which counts records, not links
  — never replaced it. The first demo run waited 150 s for a third host that could not come.
  Fixed twice over: `commandHalf` terminates the MicroVM of a killed or frozen core with the command
  (a frozen core computes nothing either; throttle is reversible and leaves it), and the fleet policy
  now retires any core that has had no node for `CORE_LINK_TIMEOUT_MS` (two minutes) — since its
  launch, or since its node left — so a core whose process never says hello is replaced too.
  `CoreRecord.unlinkedAt` carries the moment; snapshots from before read as "since launch".
- **`mise run health --cores`** asks every cloud core's own `/health` through the proxy (a token
  per MicroVM), which is how the dead-but-running core was told apart from a dead one.
- **The snapshot diet had a gap:** WP4.9 cleared an ended execution's file map only together with
  its tasks, so a ledger adopted from before, whose tasks were already gone, kept its maps (the
  first `/health` after the deploy still read 927 KB). The clearing is now judged on its own.
- **Runbook drops accumulated:** two `mandelbrot-edited` and a `verify-m2-trap` from the M2
  runbook sat in the program list for ever. Seeding now also retires an unshipped program that no
  remaining execution refers to and that is over an hour old — drops stay as long as they are used.

- **Controls were lost between subscribes.** Three runs in a row lost a click: `kill half` twice,
  the redundancy toggle once. The dashboard resubscribes silently — on a sequence gap (a fast
  cluster floods an observer: with ten nodes a frame took four seconds) and on a refresh after
  someone else's control — and a control issued in the few hundred milliseconds between the
  close and the next snapshot was dropped with a notice the test could not see. `ObserverClient`
  now holds such controls for the next live socket for ten seconds (`CONTROL_HOLD_MS`) and drops
  them after; a machine that is off still refuses them outright. Unit-tested with a fake socket.
- **The money shot's watcher stalled on CI.** Its raw second observer socket never resubscribes,
  so a gap on the slow runner froze its count at 259 of 640 while the frame finished; it now counts
  tiles from the dashboard's own state as well, which recovers from gaps by snapshot.
- **Spawn within the ceiling.** Ten spawned nodes plus three dashboards plus two cores is past the
  sixteen connections a MicroVM endpoint allows (WP4.5); the script spawns six, and says why on
  the page's own hint.

- **The redundancy toggle's counter never moved.** A twin that agreed *after* a task was done was
  counted as verified; the pair that settles a task together under redundancy — the toggle's own
  case — was not. The core now counts and announces that agreement (the plan task's too).
- **Word count's bars lasted one tick.** A person's launch ended and the loop's next frame took the
  stage at once — first from `ensureDefaultLoop`, then, once that was held, from the follow-up the
  previous loop frame had left in the queue. The loop's pause now holds new launches *and* queued
  continuations for `HUMAN_RESULT_HOLD_MS` (twenty seconds) after a person's execution ends, the
  tick starts a held continuation when the pause is over, and the snapshot shows the execution that
  ended last when nothing runs, so a resubscribing dashboard (or a visitor arriving during the hold)
  sees the result rather than "idle".
- **Every rotation terminated every core.** The link timeout measured an adopted core's silence
  from its launch, and adoption clears the links; the successor's first tick retired the fleet and
  launched it again (`mise run health -- --cores` showed three six-second-old cores after each
  rotation). Adoption now stamps the grace from the moment of adoption.
- **A CI runner's host failure took a frame down.** Ten workers on the two-vCPU runner; one
  instantiation failed with `WebAssembly.Instance(): Out of memory`, the node reported a program
  error, and the execution failed — the money shot stalled at 215 and 315 of 640 that way. A host
  that cannot instantiate the module now gives the task back (released), like a deadline kill.
- **Assertions that raced the machine.** The rotating banner's countdown is under two seconds, so
  the beat collects the banners it sees while the generation advances rather than asserting one at
  an instant; word count is followed through one logged poll; the frozen victims are named and
  watched out of the node table (a frozen core's MicroVM is replaced, so the count says nothing).

## Results

_Filled by the runs below._

## Tests

- `packages/core/src/fleet.test.ts`: a core that never says hello is terminated after the link
  timeout and replaced; a core whose node left gets the same grace; kill half or freeze half landing
  on a core terminates its MicroVM and the fleet launches another, throttle leaves it; the sleep test
  links its core so only the sleep retires it.
- `packages/core/src/loop.test.ts`: an adopted record whose tasks are long gone still loses its map.
- `packages/control-plane/src/adopt.test.ts`: an unshipped drop nobody has run is retired after an
  hour, a fresh one stays.
- The demo suite itself, against AWS, three times in a row (below).

## Drift

- `CORE_LINK_TIMEOUT_MS`; `CoreRecord.unlinkedAt`; kill/freeze half terminate victim cores.
- Seeding retires stale unshipped drops (`STALE_DROP_MS`, one hour, unreferenced).
- `mise run demo`, `mise run health --cores`.
