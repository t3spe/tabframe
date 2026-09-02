# WP3.4 — Handover tests

**Milestone:** M3 · **Branch:** `wp/3.4-handover-tests` · **Packages:** `packages/dev`,
`packages/control-plane`

## What

A rotation you can run on a laptop, and one that runs in the test suite.

- **`mise run dev:rotate`** (`packages/dev/src/rotate.ts`): the **real** rotate handler driven by a
  local driver. `LocalMicrovms` implements the fleet's `MicrovmClient` by spawning control-plane
  processes instead of launching MicroVMs — each one boots neutral (a new `TABFRAME_LOCAL_NEUTRAL`
  flag makes local mode wait for `/run`, the way the image does) and is turned into a control
  plane by the same run-hook payload the fleet sends on AWS. A small session server follows the
  pointer, so the nodes chase generations exactly as they do in the cloud, and the control-plane
  client talks to the private ports over plain HTTP. Everything above the driver — the five steps,
  the pointer and its pending record, the failure paths — is the code that runs on AWS. Flags:
  `--cores`, `--rotations`, `--interval`.
- **`packages/control-plane/src/handover.integration.test.ts`**: the same driver as a test. Two
  real control-plane processes, two real node processes running the real sandbox, the seeded
  Mandelbrot program, and a rotation taken **mid-render**, once tiles are actually landing. It
  asserts the rotation reports a handover and drains all three clients, the successor answers
  `/health` at the new generation with the program adopted rather than reseeded, both nodes come
  back on the new control plane, tiles land again, and the execution the first generation started
  is the one the second is finishing.
- The browser side of a rotation is already covered by the dashboard's demo test, which drives a
  generation change mid-frame and asserts the picture survives it. A third variant that spun two
  live control planes behind Chromium would test the driver again rather than the page; the real
  thing is measured on AWS in WP3.5.

## Two things the local run found

- **The run payload's store base must not override a local one.** The fleet passes `storeBase` in
  the payload; with a placeholder in it, every node fetched blobs from a port nobody was listening
  on and every task failed with `fetch failed`. The driver now passes an empty string, which the
  payload parser reads as absent, and each control plane keeps serving blobs from its own port.
  On AWS the store base is CloudFront and is the same for every generation, so this is a local-only
  wrinkle — but it is exactly the kind of thing a local rotation is for.
- **A node that rejoins before an observer subscribes is in the snapshot, not in an event.** The
  test counts both, which is what a dashboard has to do too.

## Left for later

- In local mode each control plane has its own in-memory store, so blobs written before a rotation
  are not readable after it. A multi-stage execution would fail its next fold locally. On AWS the
  store is shared (S3 behind CloudFront), so this is an artefact of the local topology; the test
  therefore rotates during a single stage. Recorded in the design's drift log.
- Measuring the churn (how many seconds of reconnects a rotation costs under load) is WP3.5, on
  the deployed machine.

## Evidence

Suite: 427 tests, 95 % of lines; lint and the three type-check projects green. A `dev:rotate` run
with two cores rotates generation 1 to 2, hands over, drains both nodes plus the observer, and
terminates the old control plane in about twelve seconds.
