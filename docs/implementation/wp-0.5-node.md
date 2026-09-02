# WP0.5 — Node orchestrator, minimal

**Milestone:** M0 · **Branch:** `wp/0.5-node` · **Merged:** 2026-09-01

## What

`packages/node` is the orchestrator that makes a browser tab or a MicroVM a node (design §4), in
its M0 form: session, connect, hello, heartbeat, reconnect, status. Two platform entry points share
one implementation:

- **`platform/web.ts`** — the Web Worker a host page spawns per node. It receives `init`,
  `visibility`, and `stop` over postMessage and posts `status` back. Tasks and results never cross
  that boundary; the worker owns its socket.
- **`platform/node.ts`** — one process is one node. Cloud cores run this inside the MicroVM image;
  the local topology runs two of them as stand-ins. Status is JSON lines on stdout; the process
  exits 2 without a session URL, 3 on a protocol version mismatch, 0 when the machine is off.

The orchestrator fetches a session, opens the socket to `/node` with the three MicroVM
subprotocols (none for the local token), says hello with the generation from the session,
heartbeats every interval carrying the host's visibility, and on any close reconnects through a
fresh session as a brand-new node: after exponential backoff with full jitter, or after exactly the
delay the control plane chose when the close was a rotation. A version-mismatch close stops it with
an `outdated` status so the host can reload. An `off` session stops it; a `starting` session
retries after the hint.

## How

- `Orchestrator` takes its dependencies explicitly — session URL, host id, kind, `fetch`, a socket
  factory, timers, a random source, a status sink — so the unit tests drive it with a fake socket
  and manually advanced timers and assert every transition without a network.
- Inbound messages go through the protocol codec with `expectGen` set to the session's generation;
  a bad message closes the socket with the protocol's code, the same discipline the control plane
  applies.
- The socket surface is the WHATWG shape both browsers and Node 22 provide, so the two platforms
  differ only in how they get a session URL and where status goes.
- `Backoff` is the protocol's reconnect window (0.5 s to 30 s) with full jitter; it resets on a
  successful welcome.

## Why

- **A node is a connection** (D11): no resume identity, so a reconnect is simply a new hello and
  the control plane's release-on-gone does the rest.
- **Jitter is the load-spreading mechanism** (design §8.4): the rotating close carries the delay,
  and the node honors it exactly, which is what keeps the session function under the account's
  Lambda concurrency default.
- **Heartbeats from the orchestrator, never the page** (D3): the worker owns the timer, so a hidden
  tab or heavy compute never delays liveness.

## Evidence

- `bun test`: 80 tests across the workspace; 15 new here — handshake and status transitions,
  heartbeat cadence with visibility, reconnect after backoff through a fresh session as a new node,
  the rotating close honoring its delay to the millisecond, version mismatch stopping for good, off
  and starting sessions, failed session fetches backing off, bad messages closing with the code,
  clean stop, and the helpers. An integration test spawns the real control plane and the real Node
  platform, both under Node: the node appears as `n1` with state idle, `/health` counts one node,
  and killing the process brings the count back to zero.
- Coverage 100 % lines on the orchestrator, session, and backoff; `mise run lint` clean.

## Dependencies introduced

None.

## Drift

None.

## Open

- The web platform is exercised in a browser from WP2.6 (Playwright); until then it is covered by
  the shared orchestrator tests and type-checked against the webworker lib.
