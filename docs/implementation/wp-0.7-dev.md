# WP0.7 — Dev topology

**Milestone:** M0 · **Branch:** `wp/0.7-dev` · **Merged:** 2026-09-01

## What

`mise run dev` brings the whole machine up on a laptop with one command (design §12):

- the control plane in local mode under `node --watch`, serving the web bundle, with the local
  store and the emulated session endpoint;
- two local cores, the Node platform run as two processes, stand-ins for the MicroVM cores;
- the web build in watch mode, so page edits rebuild in place.

It prints the page and health URLs, prefixes every child's output with its name, restarts a local
core that dies after a second (the way the fleet policy replaces a cloud core), and tears every
child down on Ctrl-C. `--no-watch` builds once and watches nothing, for tests and CI. Ports come
from the usual environment variables; `0` picks free ones, which is how the test runs it.

## How

- `packages/dev/src/up.ts` spawns children with `child_process`, learns the control plane's
  actual ports from its `listening` line, derives the session URL from them, and only then starts
  the cores. Its own `dev-ready` line carries the URLs so a test or another script can find them.
- Shutdown sends SIGTERM to every child and exits after a short grace period.

## Why

- **The real components, not mocks**: the dev loop runs the same control plane, orchestrator, and
  bundle the deployment uses; the only local-mode differences are the in-memory store and the
  emulated session endpoint, both inside the control plane.
- **Two local cores from day one** keep the Node platform, which cloud cores will run, exercised on
  every `mise run dev`.

## Evidence

- `bun test`: the dev test spawns `up.ts --no-watch` on free ports, waits for `dev-ready`, sees two
  nodes in `/health`, fetches the page and its config, then kills the parent and confirms the
  control plane is gone with it.
- `mise run lint` clean.

## Dependencies introduced

None.

## Drift

None.

## Open

- `dev:rotate` (a second control plane and a local handover) arrives in WP3.4.
