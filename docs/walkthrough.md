# The walkthrough: every screen, every state, everything clickable

A visitor should be able to land anywhere, in any state, and answer three questions without help:
what is the machine doing, what can I do here, and what just happened because of what I did. This
document is the inventory that makes that testable — for each screen, every state it can be in, what
the page must say, what can be clicked and what happens, and what must not be on the screen. It is
the page's contract; `e2e/walkthrough.e2e.ts` drives the machine through the states below and
asserts the sentence, the header's slot, and the exact set of enabled controls, with a screenshot
per state in the test's output. Written 2026-09-04; the test keeps it honest.

## The rules the inventory is checked against

- **R1 · One sentence of state, always.** The status line says what the machine is doing and why,
  in a visitor's words (`machineSentence` in `packages/web/src/state.ts`): "rendering mandelbrot
  e41 · render · 9 nodes", "running your wordcount e42 · map · 4 nodes · the loop waits behind it",
  "stopped by you · nothing runs until Start · a launch of yours still runs at once", "your
  wordcount e42 is done · the result stays · the loop waits for Start or ten quiet minutes",
  "paused · the editor tab is open · in-flight tasks finish, nothing new starts · closing it or
  launching resumes", "idle · the loop starts a frame when someone watches". The demo and an
  observer say what they are first. While the page is not connected the connection banner speaks.
- **R2 · Every control says what it will do, then what it did.** A label and a tooltip before the
  click; after it, an activity line and, for the page that clicked, the same line in the status
  line for five seconds. A click that could not be sent says so instead of being swallowed.
- **R3 · Disabled with a reason, not hidden.** A control that cannot apply now stays where it is,
  greyed, with the reason after a dash in its tooltip ("— not connected yet", "— nothing is
  running", "— an observer lends no cores; open the plain address to lend some"). The only slot that
  swaps its label is Stop / Start / Resume, and it always means "what you can do to the machine
  right now"; the one other label that changes is a program's "launch…", which reads "cancel" while
  its form is open.
- **R4 · Same kind, same look.** Controls that end things (Stop, kill half, kill execution, close
  all mine) share the red outline and sit together; controls that make things share the plain look.
  Links that leave the page carry ↗, and nothing else opens a tab.
- **R5 · A click never moves the page.** Results land in boxes that were already there; lists
  change a row's class instead of being rebuilt; the only scrolling is the visitor's.
- **R6 · One name per thing.** program · execution (e42) · frame (one execution of the loop's
  program) · stage · task · tile · core (any worker: a browser tab's thread or a MicroVM) · cloud
  core (the MicroVM kind) · node (the ledger's word for a core that has joined) · host (a browser) ·
  tab. The pills, the activity log, the tooltips and the docs use these words (aligned in WP8.2).
- **R7 · Every screen says where you are and how to get back.** Panel tabs and the editor say they
  were opened from the dashboard and link back; the demo says it is a demo in the status line;
  observe-only says it lends no cores.
- **R8 · Nothing happens silently.** A rotation, the loop coming back after ten quiet minutes, a
  program retired, a node lost, a launch refused: each shows in the status line and stays in the
  activity log.

## Screen A · the dashboard (`/`, `/?observe`, `/?demo=1`)

Always on screen: the header (machine pill, generation, next rotation, nodes · hosts — the cloud cores count as one host, "fleet" — sequence,
the execution pill, the loop pill, the rate, the Stop / Start / Resume slot, editor ↗), the status
line, the execution row, the picture, the task map and legend, the flash line, the counters, the
cluster controls, the redundancy toggle, the nodes table, and the aside (your nodes, programs,
queue, files, ledger, activity, consent).

| State | The page says | What can be clicked, and what happens | Not there |
|---|---|---|---|
| Connecting / waking | The connection banner: "Connecting…" or "Waking the machine…" with what to expect. | Nothing but the footer links; every control greyed, tooltip "— not connected yet". | Stale numbers. |
| Live, idle | "idle · the loop starts a frame when someone watches". | launch… (form → launch) starts at once; spawn adds nodes; Stop holds the loop before its next frame; panels open. | restart, skip, kill execution: greyed, "— nothing is running". |
| Live, the loop's frame | "rendering mandelbrot e41 · render · 9 nodes". | Stop ends it and holds the loop; kill / freeze / throttle half name their victims; resume all; restart; skip; kill execution; redundancy; a task cell → detail; launch… goes ahead of the loop. | Start. |
| Live, your launch | "running your wordcount e42 · map · 4 nodes · the loop waits behind it". | As above; Stop's tooltip names your launch. | Start. |
| Your launch done, loop yielded | "your wordcount e42 is done · the result stays · the loop waits for Start or ten quiet minutes". | Start hands the stage back; run follow-up when offered; the result is on the stage; launch… another. | Stop (nothing runs). |
| Stopped by a person | "stopped by you · nothing runs until Start · a launch of yours still runs at once". | Start; launch… runs at once (D1); spawn; panels. | restart, skip, kill execution greyed. |
| Paused by the editor tab | "paused · the editor tab is open · in-flight tasks finish, nothing new starts · closing it or launching resumes". | Resume; launch… queues and its activity line says it waits for the pause to end. | Stop / Start. |
| Execution failed | The failure box with the reason and "dismiss"; the stage says "no result" once, in grey; the sentence names the failed execution and what the loop does next. | dismiss; launch… again; its files and ledger rows stay browsable. | A second red "no result". |
| Rotating | Banner "Control plane rotating to generation 90 · reconnecting in 1.9 s …". | Everything stays; a click is held ten seconds, then reported. | An "asleep" banner, a jump, a change of size. |
| Asleep | Banner with the reason; controls greyed. | The page wakes the machine by itself. | Live-looking controls. |
| Outdated page | Connection banner "This page is out of date … Reloading…"; the page reloads itself once after 1.5 s. | Nothing needed. | Live-looking controls. |
| Outdated, reloaded once | The same banner with the hint "Reloaded once already: hard-refresh this page (Shift+reload) to fetch the current bundle." — the reload is remembered for the session, keyed by protocol version (WP8.1), so a stale cache cannot loop the page. | Shift+reload. | A reload loop. |
| Machine full | Connection banner "The machine is full." — the control plane keeps fourteen seats for clients and closed this socket with a code that says so (WP8.3); the page tries again in ten seconds. | Close a tab, or wait. | Live-looking controls; a silent "Connecting…". |
| Off | "The machine is off." with what an operator does and the demo link. | The demo link. | Anything suggesting waiting helps. |
| Observe only | "observing · this tab lends no cores · …"; the spawn hint says how to lend some. | Everything but spawn; spawn greyed with the reason. | A hint that counts this browser's cores. |
| Demo | Machine pill "live · demo"; sentence "demo · a scripted cluster inside this page, nothing is sent anywhere · …". | Everything, against the script; the editor opens in demo mode. | Links to the live machine that look like the demo. |

## Screen B · the panel tabs (`?panel=ledger`, `files`, `activity`)

| State | The page says | What can be clicked | Not there |
|---|---|---|---|
| Any tab, live | Title "Tabframe · ledger"; the explanation; "← dashboard" in the header, back to the page that opened it with its mode kept. | pause / resume updates (N held); rows → preview in place; "raw ↗"; "↗" to a pinned viewer tab. | Stop / Start / Resume, editor ↗, cluster controls, spawn: a reading tab drives nothing. |
| Files tab | Which root is shown and how many files; the preview box explains itself before a click. | stage N buttons browse an earlier filesystem; "follow the execution" returns; a file → its bytes in the box. | A preview that vanishes because a new execution started (a pinned file stays). |
| Ledger tab | "N settled tasks · bytes in the store · hashes, not bytes"; whole hashes and addresses. | A row → its bytes in the box; "raw ↗" saves the file and says so. | A download on a plain click. |
| Activity tab | "N lines · newest first". | pause updates. | Words the dashboard does not use. |
| Frozen | "resume updates (N held)" on the button. | resume updates. | A row changing while frozen. |
| Machine changes under the tab | The same banner as the dashboard, in the same slot. | Nothing new; the tab reconnects by itself. | A silent gap. |

## Screen C · the editor tab (`/editor.html`)

| State | The page says | What can be clicked | Not there |
|---|---|---|---|
| Opened | "the machine is paused while this tab is open — in-flight tasks finish, nothing new starts; launch or close to resume"; two lines on what a program is; "← dashboard", "What is a program? ↗". | The program select (every program on the machine, then the examples); the source; name, view, description, params; drop a .wasm / choose one; compile; reset source; close. | Launch before a module exists: greyed. |
| Compiling | "compiler: compiling…" | compile is busy. | A second compile on a double click. |
| Compiled | "compiled in N ms"; the module's size, hash, imports, exports, memory. | launch (upload, then "queued as e51 …"). | — |
| Edited after a compile | The module line: "the source changed since the compile; compile again to launch it". | compile. | Launch with a stale module: greyed. |
| Diagnostics | The error list with line and column. | A line → jump to it. | Launch. |
| Module dropped | "dropped module · size · hash …"; the source box says a dropped module has no source here. | launch runs it as it is; pick an example or a machine program to edit source again. | compile (greyed). |
| A program from the machine | "from the machine · source loaded (N KB) · M input files kept by hash, nothing to re-upload · edit, compile, launch as <name>-edit"; or "no source (a dropped .wasm) · launch runs the module as it is". | compile (with a source), launch (with a module), reset returns to the machine's copy. | — |
| Launched | "launched · the pause ended and the machine runs your program · keep editing, or close this tab". | Close; launch again after an edit and a compile. | A banner still claiming the machine is paused. |
| Disconnected / rotating | The machine pill says so. | Editing continues; launch says "not connected" if pressed. | A silent failure. |
| Demo (`/editor.html?demo=1`) | Pill "demo"; "the editor compiles here, nothing is sent anywhere; launching needs the live machine". | Everything but launch, which is greyed with "demo" in its tooltip. | An upload attempt. |

## Screen D · the guide page (`/guide.html`)

Static: what a program is, what it may do, the limits in numbers, the SDK's README; "← editor" and
"dashboard" at the top. Nothing to drive.
