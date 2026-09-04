# WP8.1 — Review loop 1

**Branch** `wp/8.1-review-loop-1` · **Milestone** M8 · **Date** 2026-09-04 · **Ask** Mircea:
review the code and critique it from five perspectives — full-stack developer, distributed-systems
developer, security engineer, technical writer, DevOps engineer — get the individual feedback,
aggregate, critique, incorporate; three loops. This is loop one.

## How the loop ran

Five independent reviewers (fresh agents, read-only, no AWS access) each returned at most twelve
findings with severity, location, cause, and fix. The 54 findings (two rows, 8 and 25, each merge two reviewers) were de-duplicated into the
table below (52 rows); each was accepted, deferred to a later loop, or rejected with the reason (the
critique): 45 accepted in full or in part, 6 deferred to loops 2–3, and one (11) rejected as a change but kept as a bound. The accepted ones landed on this branch with tests; CI gates the merge; the next loop
reviews the tree with these changes in.

## The findings and what was done

*From*: dist = distributed-systems developer, sec = security engineer, fs = full-stack developer,
tw = technical writer, devops = DevOps engineer. *Sev*: H/M/L as the reviewer rated it.

| # | From | Sev | Finding | Decision |
|---|---|---|---|---|
| 1 | dist | H | Stage-advancing store effects (inherited root, stage spec, folded manifest) were fire-and-forget: a handover mid-flight or one S3 error wedged the execution for ever. | **Accepted.** `resumePending()` re-derives the pending effect from the ledger on adopt and again every `STORE_RETRY_MS` (`waitingSince` on the execution); a pruned origin now falls back to the bundle with the `expired-root` warning instead of a silent start. |
| 2 | dist | H | `encode()` over 64 KB threw through `dispatch`; params and the queue were unbounded. | **Accepted.** `PARAMS_MAX_BYTES` (4 KB canonical) and `QUEUE_CAP` (32) in `enqueue`; a send that cannot be encoded closes that connection instead of throwing. |
| 3 | dist | H | A node reported store or network failures as program faults, failing everybody's execution. | **Accepted.** `hostFailure()` covers fetch, upload, presign timeouts and network errors → `RELEASED`; the store client retries three times with backoff. |
| 4 | sec | H | The control plane fetched blobs named by untrusted parties without a size check. | **Accepted.** `StoreDriver.get(hash, maxBytes)` (HeadObject first on S3, `BlobTooLarge` otherwise); caps at every fetch: stage spec 1 MB, inherited root 4 MB, bundle manifest 1 MB, program manifest 64 KB, module 8 MB. |
| 5 | sec | H | Presign sizes were unbounded and uncounted. | **Accepted.** `size ≤ maxOutputBytes` and at most 64 items per presign in the schemas; a 1 GiB presigned-byte budget per connection in the core. |
| 6 | sec | H | A module could declare a second memory without a maximum and grow past the cap. | **Accepted.** `countMemories()`; more than one memory is refused. |
| 7 | fs | H | A node's presign never timed out and an S3 HeadObject error failed the whole presign: a zombie core. | **Accepted.** `SocketPresigner` times out after 30 s (the task is released); `S3Store.presign` treats a HeadObject error as "not there" and signs. |
| 8 | tw, devops | H | The hourly rule rotated a *suspended* control plane, so an idle night booted a generation an hour and the README's stays-up paragraph was false. | **Accepted.** A scheduled invocation skips a `SUSPENDED` control plane (`skipped-suspended`); the README says what happens now. |
| 9 | devops | H | `deploy` ran build and test in parallel from the working tree with no clean-tree or green-main guard and no commit stamp. | **Accepted.** `deploy` is sequential: build → test → `deploy-guard.ts` (clean tree, HEAD on origin/main; `TABFRAME_DEPLOY_UNGATED=1` to skip) → stacks → up. `stage-image.ts` writes `build.json`; `/health` shows `build` and `imageVersion`. |
| 10 | devops | H | The rotate function returned failures as successes; nothing alarmed. | **Accepted.** The Lambda entry throws on `failed`; CloudWatch alarms on rotate/session errors and rotate throttles go to an SNS topic mailed to the budget address when configured; the hourly rule's target retries twice within thirty minutes. |
| 11 | sec | M | Destructive controls are unauthenticated; kill-half in a loop terminates and relaunches cloud cores. | **Rejected as a change, accepted as a bound.** A public machine anyone may drive is the design (D4, §6.7); a machine-wide cooldown of two seconds per destructive control (`CONTROL_COOLDOWN_MS`) removes the cost loop. |
| 12 | fs | M | The editor tab re-sent `pause` on every live socket, including after its own launch. | **Accepted.** `holdWanted` is cleared by launch and close. |
| 13 | fs | M | A failing session fetch during a silent resubscribe kept a green pill; held clicks were dropped silently. | **Accepted.** The page goes back to "connecting"; dropped clicks are said in the status line (`onDropped`). |
| 14 | fs | M | An outdated page reloaded itself in a loop. | **Accepted.** One reload per protocol version (`sessionStorage`), then a hard-refresh hint. |
| 15 | fs | M | The ledger tab serialised every row per frame; the blob cache and the demo store grew without bound. | **Accepted** (ledger signature; a 64 MB LRU `BlobCache`). The demo store's growth is deferred to loop 2. |
| 16 | fs | M | A dead compiler worker left the editor unusable. | **Accepted.** Pending compiles are rejected, a two-minute compile timeout, the next compile gets a fresh worker; failed drops say so. |
| 17 | dist | M | Between handover and promote a dead rotation left the machine dark for an hour; a predecessor kept acting after handing over. | **Accepted.** `HANDOVER_LEASE_MS` (90 s) returns a control plane to `active` when no drain follows; ticks run no fleet, loop, or assignment while `handing-over` or `drained`. |
| 18 | dist | M | Slow `RunMicrovm` calls were asked twice; surplus cores were never trimmed. | **Accepted.** `meta.coreLaunches` counts launches until acknowledged (or a minute passes); surplus unlinked cores are terminated. |
| 19 | dist | M | Any node's report could settle or fail any open task; `computeMs` was unbounded; results per task grew without bound. | **Accepted in part.** A report for an attempt the node never held may still verify or contest a settled task (D7, the tests lean on it) but can no longer *fail* a task; `computeMs` is bounded; sixteen records per task. |
| 20 | sec | M | Blobs are served on the page's origin with no `nosniff`, no CSP. | **Accepted.** CloudFront response-header policies: nosniff, DENY framing, HSTS, a CSP for the page; `Content-Disposition: attachment` and a sandbox CSP for `blob/*`. |
| 21 | sec | M | Results and presigns were exempt from the rate bucket. | **Accepted.** A second bucket (`SOLICITED_RATE` 256/s) for them. |
| 22 | sec | M | Sixteen sockets from one client lock everyone out. | **Deferred (loop 2).** Needs the client address at the endpoint; documented in §9.7. |
| 23 | sec | M | A subscribe re-serialised the whole snapshot. | **Deferred (loop 2).** Memoise pages per `meta.seq`. |
| 24 | sec | M | `RunMicrovm` was allowed on any image. | **Accepted for launches** (the Tabframe image only); Get/Terminate keep the image-wide resource until the API's MicroVM resource model is pinned down. |
| 25 | sec, devops | M | `aws-cli`, `gh`, `aws-cdk` at `latest` under an admin identity. | **Accepted.** Pinned to the installed versions. |
| 26 | devops | M | A successor that never reached RUNNING was left running and blocked later runs through a fixed client token. | **Accepted.** Terminated on timeout; the token carries the hour. |
| 27 | devops | M | No real rollback; cores not pinned to an image version. | **Deferred (loop 2).** A `rollback` task with `imageVersion` through the run payload. |
| 28 | devops | M | The base image tag and `nodejs22` are unpinned. | **Deferred (loop 2).** Pin by digest once the digest is looked up. |
| 29 | devops | M | Buckets were `DESTROY` with auto-delete and no `cdk diff` step. | **Accepted for the buckets** (blobs and snapshots `RETAIN`); a diff gate is deferred. |
| 30 | devops | L | The snapshot bucket's one-day expiry deleted `latest.json.gz` too. | **Accepted.** The rule is scoped to the `g` prefix. |
| 31 | devops | L | CI cancelled in-progress runs on `main`; no retry for browser suites; no Bun cache. | **Accepted.** Cancel only off `main`; one retry on CI; a cache for `~/.bun/install/cache`. |
| 32 | devops | L | `.env.local` loaded for every task; the exporter ran without scrub words. | **Accepted for the exporter** (refuses without `TABFRAME_SCRUB_WORDS`); per-task env scoping deferred. |
| 33 | sec | L | Fleet routes failed open without a secret; cores carried the fleet secret. | **Accepted for the routes** (an image refuses them until the secret arrives); the core payload is deferred to loop 2 with the core-identity work. |
| 34 | dist | L | A repeat `/adopt` swapped the ledger under live sockets. | **Accepted.** A control plane that already serves answers 200 without a swap. |
| 35 | dist | L | Redundancy off left open tasks waiting for a twin. | **Accepted.** Open tasks drop to one result and settle on one they hold. |
| 36 | dist | L | Cores are identified by a self-declared name. | **Deferred (loop 2).** A per-core token in the run payload. |
| 37 | dist | L | Inheritance by execution id; `restart` dropped errors. | **Accepted in part** (a pruned origin warns); inheritance by root hash is deferred. |
| 38 | dist | L | Released work went straight back to the releasing node. | **Accepted.** `eligible()` prefers another free node. |
| 39 | fs | L | The demo's spawn buttons connected for ever; stop/start/pause/resume did nothing there. | **Accepted.** Spawn is greyed with the reason; the demo answers the four controls. |
| 40 | fs | L | The off banner promised polling the client did not do. | **Accepted.** The client asks again every fifteen seconds. |
| 41 | fs | L | Keyboard and screen-reader gaps. | **Accepted in part.** `aria-live` on the status line, queue ages tick in place, panel-only controls drop `hidden`, the file input is reachable; row buttons and canvas keys are deferred. |
| 42 | fs | L | Exact-copy assertions in the browser tests. | **Deferred (loop 3).** |
| 43 | fs | L | Duplicated helpers; `MAX_BLOB_BYTES` 8 MB vs 16 MB outputs; query hashes unchecked. | **Accepted for the cap and the hashes**; the duplicate helpers are deferred. |
| 44 | tw | H | The README's stays-up paragraph was false while the hourly rule rotated a suspended control plane. | **Accepted.** Rewritten around the `skipped-suspended` rule of finding 8. |
| 45 | tw | M | The design record's status line and four stale body facts. | **Accepted.** Corrected in place; the drift log carries the WP8.1 entry. |
| 46 | tw | M | "Core" meant three things across the docs. | **Accepted in part.** The README and glossary were aligned; loop 2 amends the walkthrough's R6 (a core is any worker, a cloud core a MicroVM worker, a node the ledger's word). |
| 47 | tw | M | Stale counts of tests and programs. | **Accepted.** Counts are re-derived at each close-out. |
| 48 | tw | M | No "try it" in the README; missing reading rows. | **Accepted.** A try-it list and the reading rows were added. |
| 49 | tw | L | The rationale said "first extension" where there had been two. | **Accepted.** "second extension". |
| 50 | tw | L | Runbook rows for a removed constant; the plan's "six milestones". | **Accepted.** Rows dropped; eight milestones plus M8. |
| 51 | tw | L | The drift log's orphan paragraph and §9 numbering. | **Accepted, badly.** The repair garbled the WP1.9 entry and fused seven entries; loop 2 rebuilt §17 from the pre-loop text, removing only the duplicated paragraph. |
| 52 | tw | L | The editor's select label; the guide's repository-only sections; §5.6's API. | **Accepted.** The label names the program; the guide is cut before "## Compiling" in `guideMarkdown()` (`packages/web/src/editor-core.ts`), not in the SDK README; §5.6 describes the API as built. |

## Deferred to loops 2–3

- 22 (loop 2): Sixteen sockets from one client lock everyone out.
- 23 (loop 2): A subscribe re-serialised the whole snapshot.
- 27 (loop 2): No real rollback; cores not pinned to an image version.
- 28 (loop 2): The base image tag and `nodejs22` are unpinned.
- 36 (loop 2): Cores are identified by a self-declared name.
- 42 (loop 3): Exact-copy assertions in the browser tests.

## Tests

- Core: `review-loop-1.test.ts` (re-derived spec fetch and fold after an adopt and after silence, the pruned origin, params and queue caps, the cooldown, the presign budget, the handover lease, redundancy off); `apply.test.ts` (the solicited bucket), `fleet.test.ts` (one launch per acknowledgement); the churn simulation passes with the cooldown in.
- Protocol: presign bounds. Sandbox: a second memory is refused. Store: the size-capped get. Node: host and store failures are releases; the presign timeout.
- Fleet: the stuck successor is terminated, the token carries the hour, a suspended control plane is skipped on schedule and rotated by an operator.
- Every browser suite passes locally; the CDK app synthesises.

## Drift

`docs/design.md` §17 entry of 2026-09-04 (WP8.1); the README, runbook, and rationale corrections listed above.
