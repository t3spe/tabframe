# WP1.6 — Node orchestrator v1

**Milestone:** M1 · **Branch:** `wp/1.6-node-v1` · **Package:** `packages/node` (plus one line in
`packages/web`, one constant in `packages/protocol`, one branch in `packages/core`)

## What

The orchestrator now does the job design §4 gives it. M0's version handshook and heartbeat; this
one takes work:

- **The task loop.** An `assign` is accepted while the node holds fewer than `maxInFlight` tasks
  (the welcome says how many; the default is two: one running, one queued). Tasks run one at a
  time through the platform's sandbox. Extras are logged and dropped — the control plane sees them
  time out and speculates, which is the design's answer to any lost assignment.
- **`TaskRunner`** (`tasks.ts`): the program module is fetched from the store by hash and compiled
  once per node (eight cached, oldest evicted); the stage manifest is fetched by `fsRoot` and cached
  the same way (a null root is an empty manifest). A `run` task's inline input is framed with
  `encodeRunInput` (stage, index, count) before the sandbox sees it; a `plan` task's input arrives
  already framed by the control plane and passes through. The sandbox gets the control plane's
  deadline plus one grace second, so the control plane's own timer fires first and speculates
  before the node kills anything (§4.2). A successful task's output, every written file, and an
  oversized log are uploaded in one `putMany` — one presign round trip, one PUT per blob the store
  does not already have — and the `result` names the hashes and sizes the store vouched for
  (§7.3). Logs up to four kilobytes travel inline.
- **Presign over the socket** (`SocketPresigner`): the node's `StoreClient` asks for upload URLs
  with a `presign` message and resolves on the matching `presigned` (D18: no HTTP API on the
  control plane for browsers). One request is outstanding at a time; a socket close rejects it,
  which fails the task locally and, since the socket is gone, goes nowhere — the next session
  starts clean.
- **Cancel** drops a queued task or terminates the sandbox worker under a running one. The run
  resolves as `disposed`, which the runner reports as *dropped*: no result, nothing counted. The
  next task gets a fresh worker from the platform.
- **Commands** (§6.6): `close` stops for good (the web worker closes itself; the Node process
  exits and its supervisor brings a fresh one); `freeze` stops heartbeats and work but leaves the
  socket open, so the control plane sees a node that went silent; `throttle` idles nine times the
  task's compute after each task, with a fifty-millisecond floor so tiny tasks still slow down;
  `resume` clears both.
- **Reconnect** goes through a fresh session as before; assignments belong to the connection, so a
  closing socket drops queued and running work (the control plane releases attempts of a node that
  vanished, §6.4) and the presigner is reset. A close now emits a `connecting` status with the
  reconnect delay, so a host sees the transition at once.
- **Status** carries `queue` (accepted tasks including the running one) alongside the M0 fields;
  the state is `busy` while a task runs, `frozen`/`throttled` under those commands or when the tab
  is hidden, `idle` otherwise.
- **Same code on both platforms.** `platform/web.ts` builds the sandbox with
  `createWebSandboxHost` pointed at `sandbox.js` next to the node worker's own script (a new
  `packages/web/src/sandbox.ts` entry re-exports the sandbox's web worker; the build script already
  bundled it when present). `platform/node.ts` uses `createNodeSandboxHost` with a read-only
  `StoreClient` behind the bridge's `fetchBlob`, serving whole blobs and ranges alike.
- **Store base resolution.** A relative store base (`/blob`, local mode) is resolved against the
  control plane's own HTTP origin, taken from the socket endpoint; an absolute one (CloudFront) is
  used as is.

## A small protocol and core change: `released`

The sandbox reports a deadline kill as `{ok: false, error: "deadline"}`. Sending that up as an
ordinary error would fail the task and, through §6.5, the execution — for what is a slow node, not a
program fault. The node therefore sends `error: "released"` (`RELEASED` in the protocol) and the
core treats it as the node giving up: the attempt's outcome becomes `released`, the node's
in-flight list and statistics are not credited with a completed task, and a task left with no
running attempt and no result this round goes back to the front of the queue as released work
(tier one), announced with `taskReassigned`. The refill happens in the same step, so the task is
usually re-assigned before the effects leave the function. Recorded in the design's drift log.

## Tests

- `orchestrator.test.ts` (fake socket, fake timers, a hand-settled fake sandbox, an in-memory blob
  server behind `fetch`): the full assign → fetch → compile → run → presign → upload → result path
  with the ABI framing checked by decoding what the sandbox received; the module cached across
  tasks; blobs the store already has skipped; the queue cap and the heartbeat's queue count; a
  trap as an error result with its log; a deadline kill reported as `released`; cancel of a queued
  and of a running task; freeze (silent, socket open, assignments ignored) and resume; throttle
  timing (nine times compute, the floor) and resume; close; a socket dropping mid-task; a stray
  `presigned`; a missing program; store base resolution. The M0 tests still pass unchanged.
- `tasks.test.ts`: the runner in isolation (framing, manifest cache and the empty manifest,
  uploads and the result's hashes and sizes, inline versus uploaded logs, trap/deadline/disposed
  outcomes, failed fetches not cached, abort), the presigner's matching, single-flight, and reset,
  and `fromBase64` against `Buffer` for every length up to 64.
- `tasks.integration.test.ts`: the runner with the **real** sandbox (worker thread, bridge reader)
  and the **real** Mandelbrot module compiled at test time: plan stage 0 yields a 640-task spec,
  tile 0 renders 64×64 RGBA bytes whose hash equals the golden the SDK suite pins.
- `packages/core/src/release.test.ts`: a released result frees the attempt without failing
  anything, announces the reassignment, refills, and keeps the invariants.

Suite: 265 tests, lint and the three type-check projects green.

## Why this shape

- The runner is separate from the orchestrator so the task path can be tested without sockets, and
  so the same runner serves an eventual third platform.
- The node kills at deadline plus a second rather than at the deadline: the control plane must
  always be the first to notice lateness (§4.2), or a speculative twin would never be needed.
- Refusing an over-capacity assignment instead of queueing it keeps the node's promise in the
  heartbeat (`queue ≤ maxInFlight`) honest; the control plane never sends more than it granted,
  so this only matters under a bug or a replay, both of which the timeout absorbs.
- A throttle floor makes the demo legible: Mandelbrot tiles take a few milliseconds, and nine
  times a few milliseconds would look like nothing happened.

## Left for later

- The browser worker's sandbox URL is the bundled `sandbox.js`; the host page (WP1.8) needs no
  change, but a page that serves the node worker from elsewhere can pass `sandboxUrl` in `init`.
- End-to-end through the control plane (seeded programs, launch, a canvas hash equal to the
  golden) is WP1.7 and WP1.10.
