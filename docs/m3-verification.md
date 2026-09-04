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

## The endpoint's concurrency ceiling — resolved

Measured while preparing this run, then isolated afterwards (WP4.5,
`packages/infra/scripts/socket-ceiling.ts`):

| Experiment | Sockets before 429 |
|---|---|
| live control plane, one client, one token | 16 |
| fresh throwaway MicroVM, 1 GB, nothing else connected | 16 |
| fresh MicroVM, three independent tokens | 16 in total |
| fresh MicroVM, three client processes on one machine | 16 in total (6 + 5 + 5) |
| fresh MicroVM, 512 MiB | 16 |
| fresh MicroVM, 4 GB | 16 |
| fresh MicroVM, 6 GB | 16 |

Pacing did not matter (0.5, 2 and 10 opens a second all stopped at 16) and 3125 retries over 150
seconds never got a seventeenth through. The account's Service Quotas name the cause: **Concurrent
connections per 2 vCPU MicroVM = 16**, not adjustable, alongside 8 / 32 / 64 / 128 for the 1 / 4 / 8
/ 16 vCPU classes. The class is not ours to choose — `RunMicrovm` takes only a minimum memory, and
every size we can launch under the account's 8 GB memory quota behaves as the 2-vCPU class.

While the sixteen sockets are open, the fleet's calls to the private port are refused too; with no
extra sockets the same calls succeed. Client connections and fleet requests share one budget at the
endpoint, which is why two of the four rotations above fell back to the snapshot.

The M0 record's "250 sustained sockets" was a counting error, corrected in `docs/m0-verification.md`.

What follows for the design: one control plane holds about seven browser tabs that each lend a node, or fourteen that only watch; the ledger's
256-node cap is a scheduler property, not a deployment one; and thousands of concurrent clients need
an edge tier that is not a MicroVM endpoint — design §9.7 sets out the options, and the plan's WP4.6
carries the decision. The system as built tolerates the limit: a rotation that cannot hand over
adopts the snapshot instead, with the same churn.

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
