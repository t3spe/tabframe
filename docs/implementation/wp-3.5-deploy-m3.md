# WP3.5 — Deploy M3

**Milestone:** M3 · **Branch:** `wp/3.5-deploy-m3` · **Packages:** `packages/infra`,
`packages/fleet`, `packages/control-plane`, `packages/node`

## What

M3 on the real machine, and the runbook that measures it: `mise run verify:m3`
(`packages/infra/scripts/verify-m3.ts`). It opens browser tabs on the deployed page, waits until
tiles are landing, invokes the rotate function, and reports the rotation's outcome, the drain, the
**churn** — how long from the drain to the first tile of the new generation — the nodes that came
back, and what CloudWatch says about the session function's concurrency and throttles. Flags:
`--clients`, `--tabs`, `--timeout`. `docs/m3-verification.md` has the table.

**The headline: a rotation costs about 8.4 seconds of render**, and the frame in flight continues
rather than restarting. The session function peaked at three concurrent executions with no
throttles.

## Three fixes the deploy found

- **The bundled image could not spawn its sandbox worker.** `createNodeSandboxHost` defaults to the
  package's `node-worker.ts`, which does not exist inside a single bundled `main.js`; every task a
  cloud core took failed with `Cannot find module '/app/node-worker.ts'`. `build:image` now bundles
  the worker as a second entry point, `stage-image` copies it, the Dockerfile installs it, and the
  image environment names it with `TABFRAME_SANDBOX_WORKER`, which both the core inside the image
  and the standalone Node platform honour. Proved before redeploying by running the staged bundle
  against a local control plane: 116 tiles, no failures.
- **The fleet's calls to the private port can be throttled.** `/handover` and `/drain` were
  answered 429 during a rotation. `HttpControlPlaneClient` now retries a throttled or 5xx call
  three times with backoff, and only 4xx answers that mean "no" (403, 409) fail immediately.
- **The runbook's own client simulation was wrong twice**: simulated clients that never heartbeat
  are declared gone in four seconds, so the drain found nothing to close; and Node's global
  `WebSocket` hid the endpoint's 429 behind a generic error, which the `ws` client reports plainly.

## What the runbook measured that we did not expect

One client process can hold about **16 concurrent sockets** through the MicroVM endpoint; beyond
that the upgrade is refused with 429, at any pacing, and retries do not help. While those sockets
are open the fleet's private-port calls are refused too — with no extra sockets the same calls
succeed. That is a shared budget at the endpoint, and it contradicts the M0 measurement of 250
sustained sockets. `docs/m3-verification.md` records the numbers and what remains unexplained. The
system tolerates it (the successor adopts the S3 snapshot when the handover cannot happen, and the
rotations completed with the same churn either way), but the design's assumption that the 256-node
cap is the binding constraint is now known to be wrong.

## Tests

`packages/fleet/test/cp-client.test.ts` gains three cases for the retry: a 429 retried and then
succeeding, a 403 refused at once, and giving up after the backoff schedule with the last status in
the message. The suite is otherwise unchanged.

Suite: 429 tests; lint and the three type-check projects green.

## Left for later

- A fleet path that does not share the clients' endpoint — the private port through a different
  route — would make the handover reliable under load. M4.
- The hourly rule is enabled by `mise run up`, so the machine now rotates on its own; the four
  rotations in this work package were invoked by hand to measure them.
