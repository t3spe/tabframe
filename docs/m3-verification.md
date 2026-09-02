# M3 verification

`mise run verify:m3` against the deployed machine in the Tabframe account (us-west-2) on
2026-09-02. It opens browser tabs on the real page, waits until tiles are landing, invokes the
rotate function, and measures what a rotation costs: how long the render is interrupted, whether
the ledger is handed over, and what the session function did while every client reconnected.

| Check | Result | Pass |
|---|---|---|
| Session before | generation 11 | yes |
| Render in flight | 10 tiles landed before the rotation | yes |
| Rotation | rotated to generation 12, handed over, 10 clients drained | yes |
| Drain | 10 clients let go by the control plane with the rotating code | yes |
| Session after | generation 12 | yes |
| **Churn** | **8.4 s from the drain to the first tile of the new generation**; 25.8 s from the rotate invocation, which includes booting the successor | yes |
| Nodes after | 6 nodes on the new control plane: the tabs came back on their own | yes |
| Session function | peak 3 concurrent executions, 0 throttles, 17 invocations a minute | yes |

Nine checks, none failed. Four rotations were run in all; the churn was 8.4 to 8.5 seconds every
time.

## What it means for the design

- **A rotation costs about eight seconds of render, once an hour.** The clients are told to come
  back with a jittered delay, they fetch a fresh session, and tiles resume. The frame in flight
  continues on the new generation rather than restarting: the ledger came across, so the tasks
  already done stay done.
- **The session function is nowhere near its limits.** Peak three concurrent executions against an
  account limit of ten, no throttles, seventeen invocations in the busiest minute. The jitter
  window plus the shared cached token do what they were designed to do.
- **The handover is an optimization, not a dependency.** In two of the four rotations the fleet
  could not reach the outgoing control plane (see below) and the successor adopted the S3 snapshot
  instead. Both rotations completed correctly with the same churn; the only cost was the work of
  the last few seconds being recomputed, which idempotent tasks make safe.

## The endpoint's concurrency ceiling

Measured while preparing this run, and the reason the runbook simulates no extra clients by
default:

- One client process could hold about **16 concurrent WebSocket connections** through the MicroVM
  endpoint. Beyond that the endpoint answers **429** to the upgrade. The ceiling did not move with
  the pacing: 0.5, 2, and 10 opens per second all stopped at 16, and 3125 retries over 150 seconds
  did not get a seventeenth through.
- While those sockets are open, the **fleet's own calls to the private port are refused with 429
  too** — `/handover` and `/drain` both. With no extra sockets, the same calls succeed. So client
  connections and fleet requests share one budget at the endpoint.
- This contradicts the M0 measurement of 250 sustained sockets against a throwaway MicroVM
  (`docs/m0-verification.md`). The difference has not been isolated: candidates are the VM's size,
  the token's scope, or a per-source limit that the M0 run did not reach. It is recorded here
  rather than explained.

What follows for the design: the ledger's 256-node cap is not the binding constraint, the endpoint
is, and the machine's real capacity through one control plane is on the order of tens of
connections from one source. The fleet already tolerates this — the retry added in this work
package gives a throttled call three more goes, and a handover that still fails falls back to the
snapshot — but a fleet path that does not share the clients' endpoint would be the honest fix.
Noted for M4.

## Notes

- **The bundled image could not spawn its sandbox worker.** A cloud core inside the image failed
  every task with `Cannot find module '/app/node-worker.ts'`: one bundled file cannot be its own
  worker thread. The build now bundles `node-worker.js` beside `main.js`, the Dockerfile copies it,
  and the image names it to the process with `TABFRAME_SANDBOX_WORKER`. Every task failed until
  this was fixed, and the default loop's backoff is what kept the machine from spinning while it
  was broken.
- **`AWS::Lambda::MicrovmImage` reported `NotStabilized` on an update whose build then succeeded on
  retry.** The build history shows version 4.0 FAILED with *"MicroVM terminated while its snapshot
  was being taken"*, and version 5.0 SUCCESSFUL two minutes later. CloudFormation rolled the stack
  back anyway; a plain re-run of `cdk deploy` completed. Treat a NotStabilized image update as
  worth one retry before investigating.
