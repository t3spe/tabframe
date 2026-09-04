# WP7.7 — The walkthrough

**Branch** `wp/7.7-walkthrough` · **Milestone** M7 · **Date** 2026-09-04 · **Ask** Mircea, with the
third review: "a comprehensive walkthrough of the UI considering all the things that can be
done/clicked at any point in time in a certain screen, and ensure that the experience is consistent
for a visitor and they don't get confused as to what is going on".

## What landed

- **The contract: `docs/walkthrough.md`.** Every screen (the dashboard, the panel tabs, the
  editor, the guide), every state each can be in, what the page must say, what can be clicked and
  what happens, and what must not be on the screen — checked against eight rules: one sentence of
  state always (R1); every control says what it will do and then what it did (R2); disabled with a
  reason, not hidden (R3); same kind, same look (R4); a click never moves the page (R5); one name
  per thing (R6); every screen says where you are and how to get back (R7); nothing happens
  silently (R8).
- **The sentence of state (R1).** `machineSentence()` in `packages/web/src/state.ts` puts one
  sentence in the status line whenever no control echo is showing: the loop's frame, a person's
  launch, held by Stop, yielded, paused by the editor, failed, queued, idle — with "demo · a
  scripted cluster inside this page, nothing is sent anywhere" or "observing · this tab lends no
  cores" first when that is what the page is. While the page is not connected the connection banner
  speaks instead.
- **Reasons, not disappearances (R3).** Every control's tooltip gains the reason after a dash
  when it cannot apply: "— not connected yet" while connecting or asleep; "— nothing is running"
  on restart, skip, and kill execution while the machine idles (kill execution is no longer hidden);
  "— an observer lends no cores; open the plain address to lend some" on the spawn controls of an
  observe-only page, whose spawn hint says the same instead of counting this browser's cores.
- **Where you are and the way back (R7).** Panel tabs show "← dashboard" in the header (the
  dashboard with the page's own mode kept) and no longer show Stop / Start / Resume or editor ↗: a
  reading tab drives nothing. The editor's head links "← dashboard" beside "What is a program? ↗".
- **The editor's honesty.** Editing after a compile greys launch until the next compile and says so
  in the module line (the uploaded source is always the compiled text). A dropped module empties
  the source box into a note — a dropped module has no source here — and greys compile until an
  example or a machine program is picked. After a launch the pause line reads "launched · the pause
  ended and the machine runs your program · keep editing, or close this tab". The demo's dashboard
  opens the editor as `/editor.html?demo=1`: the compile is real, launch is greyed with "demo" in
  its tooltip, and the head says nothing is sent anywhere.
- **Small words (R1, R8).** A launch queued while the editor holds the machine says it waits for
  the pause to end; a failed execution's stage says "no result · the execution failed; the box above
  says why" in grey instead of repeating the reason in red.

## What the walkthrough found

Running the walkthrough after the sandbox suite (a planner that traps) showed a fresh dashboard
stuck at "connecting": the control plane sent its snapshot and the page closed the socket and
tried again, for ever. The trapped plan task was recorded as the task's accepted result with an
empty output, the task view sent `output: ""`, and the protocol schema (a hash or null) rejected
the whole snapshot. Every visitor arriving after any trap, until that execution was pruned, would
have seen the same. The core's task view now gives a failed task no output, and a core test decodes
the snapshot after a trap with the protocol schema.

## Tests

- `packages/web/src/state.test.ts`: the sentence for every state and the demo / observer prefixes.
- `e2e/walkthrough.e2e.ts` (live, local control plane): drives idle → stopped → started → paused
  by the editor → a person's launch running → killed (failure box, yielded, Start), then observe-only,
  the demo, a panel tab, and the demo's editor. For each state one evaluate reads the sentence, the
  header's slot, and every control's enabled state and tooltip, and the test asserts the exact set;
  a screenshot per state lands in the test's output directory (`walkthrough-<state>.png`).
- `packages/core/src/programs.test.ts`: a failed plan task has no output in the view and the
  snapshot after a trap decodes.
- Every earlier suite passes unchanged except where the wording moved (the kill execution button
  is disabled rather than hidden when idle; the status line carries the sentence of state).

## Drift

`docs/design.md` §8.3 (the status line's sentence, the reasons in tooltips, the reading tabs) and
§17 entry of 2026-09-04 (WP7.7).
