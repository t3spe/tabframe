# Runbook

How to operate the deployed Tabframe machine. Every command below runs from the repo root with
`mise`, which sets the AWS profile (`tabframe`, the dedicated account) and the region; nothing here
works with any other profile, by design (`mise run whoami` is the guard every task depends on).

## What is running

| Thing | Where | Notes |
|---|---|---|
| Control plane | one Lambda MicroVM, 1 GB, generation-stamped | pointed at by the SSM parameter `/tabframe/pointer`; rotates hourly |
| Cloud cores | up to two 0.5 GB MicroVMs while the machine is awake | launched by the control plane; asleep ten minutes after the last observer leaves |
| Session function | Lambda function URL (public) | vends the endpoint and a shared token; heals when nothing runs |
| Rotate function | Lambda, hourly EventBridge rule | launches the successor, hands over, flips the pointer, drains, terminates |
| Store | S3 behind CloudFront (`/blob/*`) | content-addressed, one-year lifecycle |
| Snapshots | S3, `g<generation>/<time>.json.gz` and `latest.json.gz` | the `g*/` history expires after a day; `latest.json.gz` is kept |
| Alarms | SNS topic `tabframe-alarms` | rotate and session errors, rotate throttles, and the canary's page and session checks (WP8.1, WP8.2); mailed to the budget address when configured. The subscription must be confirmed from that mailbox once: `aws sns list-subscriptions-by-topic` shows `PendingConfirmation` until then |
| Canary | Lambda, five-minute EventBridge rule | fetches the page's `config.json` and the session URL, never the MicroVM endpoint; metrics under `Tabframe/Canary` |
| Page | S3 behind the same CloudFront distribution | `https://d2w9z8juw4oo76.cloudfront.net` |

## Everyday

| Task | Command | What it does |
|---|---|---|
| Is the machine up? | `mise run health` (`-- --cores` asks each cloud core too) | `/health` and `/diag` of the active control plane through the proxy on the private port, masked. Counts, phase, fleet, snapshotter status, a store round trip, memory. |
| Bring it up | `mise run up` | Sets the pointer to *on*, enables the hourly rule, invokes rotate once. Idempotent: a running control plane is rotated, not duplicated. |
| Take it down | `mise run down` | Disables the rule, terminates every MicroVM from our image, writes *off*. The page shows an off screen; the session function heals nothing. **Destructive: every MicroVM is terminated and the page goes dark until `up`.** |
| Deploy | `mise run deploy` | Refuses unless the tree is clean, HEAD is on `origin/main`, and that commit's CI is green (`TABFRAME_DEPLOY_UNGATED=1` skips the check for an emergency deploy from a branch); builds programs, page, and image; runs lint and every test; fails on any IAM or security-group broadening in `cdk diff --security-only` (`TABFRAME_DEPLOY_IAM=1` acknowledges one); `cdk deploy --all`; then `up`, which rotates the running control plane onto the new image. A deploy is a rotation. |
| Rotate by hand | `mise run rotate` | One rotation now (same code the hourly rule runs). |
| Watch logs | `mise run logs`, `mise run logs:fleet` | The MicroVM log group (one stream per VM) and the two functions' groups. See *Observability* for what actually lands. |
| Verify | `mise run verify:m1` / `verify:m2` / `verify:m3` | The milestone runbooks against the live machine: a frame through a kill-half, the editor and word count, a rotation under load. Each prints one line per check and exits non-zero on a failure. |
| Simulate | `mise run sim -- --seed N` | The churn simulation, locally; `--long` for the nightly shape. |

## Deploy, step by step

1. `main` is green in CI (`mise exec -- gh run list --branch main --limit 1`). This is a rule, not a
   preference (plan §0).
2. `mise run deploy`. The image build takes three to five minutes; the first build after a long
   gap has taken fifty. If CloudFormation reports the image "did not stabilize", check the build
   history — the platform has retried and succeeded on its own once while CloudFormation gave up;
   `mise run deploy:stacks` then completes it (the staged image, then `up`; WP8.2).
3. `up` at the end of the deploy rotates: the old control plane hands its ledger to the new one,
   the clients are drained with a jittered reconnect delay, and the render continues on the new
   generation. Expect about eight seconds of churn.
4. `mise run health` shows the new generation. `mise run verify:m1` if the change touched the
   scheduler, the node, or the store; `verify:m2` for the editor, seeding, or programs; `verify:m3`
   for the fleet.

**Rollback.** The image keeps every version; `/health` names the one running (asked of the
platform, WP8.3) and `mise run health` prints the pointer's. `mise run rollback -- <version>` writes
the pin into the pointer (`pinnedImageVersion`, read by every rotation, hourly ones included) and
rotates once; the successor boots from the pinned version, adopts the current ledger, and launches
its cores at the version it runs itself. `mise run rollback -- --clear` removes the pin, and so does
`up`, which ends every deploy (WP8.3: the pin used to be a hand-edited function environment that a
control-plane-only deploy left in place). A rollback of the page is a
re-deploy of the Web stack from the previous commit.

## Rotation, and when it goes wrong

The rotate function is idempotent and safe to invoke at any time. It reads the pointer, and:

- pointer *off* → does nothing;
- nothing serving → launches a control plane (the heal path; the session function triggers this
  when a visitor arrives and nothing runs);
- a control plane serving → launches the successor with the latest snapshot key, `/handover`,
  `/adopt`, flips the pointer, `/drain`, waits five seconds, terminates the old one.

A run that dies half-way leaves a `pending` record in the pointer. The next run promotes that
successor only if nothing else serves; if the old control plane still does, the stale successor is
terminated and the rotation starts afresh (WP6.7); if it is gone, the record is forgotten. A run
that died after the flip leaves a `retiring` record instead, and the next run drains and terminates
that predecessor before anything else (WP8.2). A `/handover` that fails costs nothing
but the last five seconds of work: the successor booted from the snapshot, and every task is
idempotent. The rotate logs say which path ran: `mise run logs:fleet`.

## Observability

- **`/health`** (private port, fleet secret): role, phase, generation, awake and why not, nodes by
  kind, cores with their age and whether their node is connected, programs, running execution,
  queue, ledger sizes, loop backoff, snapshotter writes and last key, uptime, and since WP8.1 the
  `build` stamp (`sha` with `-dirty` when the tree was, `branch`, `ungated`, `at`; served whole since
  WP8.3) and the `imageVersion` it runs.
- **`/diag`** (private port, fleet secret): DNS, a store put-and-get round trip with its latency,
  which store driver, snapshotter status, memory, the environment facts that matter
  (`TABFRAME_SANDBOX_WORKER`, cloud cores enabled).
- **The dashboard** is the observability surface a reviewer sees; everything above is for the
  operator.
- **CloudWatch.** The functions log JSON lines to their own groups, kept fourteen days. The MicroVM
  group `/aws/lambda/microvms/tabframe` (seven days) gets one stream per MicroVM; the image-build
  streams carry the whole Docker build, but each *run* stream carries **only the first line the
  process writes** — measured on 2026-09-02 with the same line written to stdout and stderr: both
  copies arrive, nothing after. The platform forwards a process's output during boot and stops.
  So for a running control plane the truth is `/health`, `/diag`, the snapshots in S3, and the
  dashboard; the rotate function's log says what every rotation did. Accepted; see design §9.3.

## Cost and budget

- The budget `tabframe-monthly` is $100 with notifications at 50, 80 and 100 % to the address in
  `.env.local`; it never acts on its own (D20 — no automatic kill switch). The notification path
  was proven on 2026-09-03 with a one-cent test budget, since deleted.
- What costs money while the machine is up: the control plane MicroVM (always, until `down`), two
  cores while anyone is watching, snapshot writes every five seconds while the ledger changes,
  CloudFront and S3 for the page and blobs. Idle, it is one suspended MicroVM's snapshot storage
  until the platform's eight-hour ceiling ends it; after that nothing runs until a visitor's
  session call heals (WP8.3: the scheduled rule and the canary leave that heal to a visitor, so an
  idle night no longer boots a generation an hour).
- Cost Explorer lags a day; `aws ce get-cost-and-usage` is the query, and the plan's WP4.7 keeps
  the first real number.

## Incidents seen so far, and what to do

| Symptom | Cause | Action |
|---|---|---|
| A page cannot connect; sockets answer 429, or the banner says the machine is full | the endpoint holds **16 concurrent connections per MicroVM** (a non-adjustable quota, design §9.7) | count what is connected (`mise run health`); close what should not be there. Leaked headless browsers from a killed runbook have done this twice — `pkill -f headless_shell`. |
| Rotation logs say `/handover … answered 429` | client sockets crowd out the fleet's private-port calls | nothing: the successor adopted the snapshot; the rotation completed |
| Every task fails with `Cannot find module '/app/node-worker.ts'` | the bundled image cannot spawn its own file as a worker | the image stages `node-worker.js` beside `main.js`; a build without it is broken — rebuild |
| Executions fail every few seconds and the loop relaunches | a program fault or an upload failure | the default loop backs off (5 s doubling to 5 min); read the failure reason on the dashboard or in `/snapshot`; `killExecution` from the page stops the current one |
| `did not stabilize` on the image update | CloudFormation gave up before the platform's retry succeeded | re-run `mise run deploy:stacks`; check `latestActiveImageVersion` |
| A program shipped in the image is not on the machine | the ledger was adopted from a snapshot seeded before the program existed | fixed since WP2.7 (seeding by bundle hash); if it recurs, `mise run rotate` |
| The session function returns `starting` for minutes | no control plane and the heal did not complete | `mise run logs:fleet`; `mise run up` |
| The machine is up but nothing renders | asleep (ten minutes without an observer) or no nodes | open the page; the first visitor wakes it, cores follow within seconds |
| After a deploy the machine renders the *old* frame, or the program list shows two `mandelbrot` | the adopted ledger's default loop pointed at the previous bundle (fixed in WP4.9: seeding retires the old record and moves the loop) | `mise run health` lists programs; if it recurs, `mise run rotate` re-seeds |
| Right after a rotation every core is a few seconds old | before WP4.4's fix the successor terminated every adopted core on its first tick; fixed — an adopted core keeps its grace from the adoption | `mise run health -- --cores`; if it recurs, check `unlinkedAt` handling in `adoptLedger` |
| The dashboard shows "The machine is asleep" for a few seconds at the start of a rotation | a pending successor left by an interrupted or racing rotation was promoted without a handover, old snapshot and all (fixed in WP6.7: it is terminated while the current control plane serves; the hourly rule skips a rotation younger than five minutes) | `node packages/infra/scripts/rotation-probe-busy.ts` watches a rotation on a busy machine the way a browser does; `rotation-probe.ts` for a quiet one |
| A person's launch finished and the loop's frame replaced it at once | since WP6.8 the loop yields to a person's launch until Start or ten quiet minutes (`YIELD_IDLE_MS`, `meta.loopYielded`); if it takes the stage back sooner, check `meta.loopYielded` in a snapshot | — |
| `/health` shows a core with `linked: false` for minutes | its node closed (a kill half picked it) or never connected | since WP4.4 the control plane terminates a killed or frozen core at once and replaces any core unlinked for two minutes; `mise run health -- --cores` asks each core's own `/health` |
| RSS climbs in the first half hour after a launch | heap growth to the working set, not a leak: 312 → 370 → 372 MiB over 7 → 33 min on a 1 GB control plane, flat after | `mise run health` shows `memoryMiB`; worry above ~700 MiB |
| An alarm email arrived (`tabframe-alarms`) | the rotate or session function failed, or rotate was throttled (WP8.1: a failed rotation is an error now) | `mise run health`; the rotate function's log names the reason; a heal runs on the next visitor or `mise run rotate` |
