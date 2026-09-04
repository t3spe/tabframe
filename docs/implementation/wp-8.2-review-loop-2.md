# WP8.2 — Review loop 2

**Branch** `wp/8.2-review-loop-2` · **Milestone** M8 · **Date** 2026-09-04 · **Ask** Mircea:
review the code and critique it from five perspectives — full-stack developer, distributed-systems
developer, security engineer, technical writer, DevOps engineer — get the individual feedback,
aggregate, critique, incorporate; three loops. This is loop two, on the tree with loop one merged.

## How the loop ran

Five fresh reviewers (independent agents, read-only, no AWS access), each given the loop-one note
first so they would check what it claimed, each returned at most twelve findings with severity,
location, cause, and fix. Their 57 findings de-duplicated into the table below; each was accepted,
deferred with a reason, or rejected with the reason (the critique). Of the 52 rows, 51 are accepted in full or in part (9 of them with a part deferred to loop 3, and one with a part rejected), 1 deferred whole, none rejected whole. The accepted ones
landed on this branch with tests; CI gates the merge; loop three reviews the tree with these
changes in and reads this note first.

7 rows carry the marker *loop-1 regression* (rows 6, 13, 15, 23, 24, 31, 34): loop-one changes that did not
hold or were incomplete — the presign cap made many-file tasks loop across the cluster, the IAM
scoping was never applied, the build stamp never reached the image, the presign budget was a lifetime
cap, the compile worker was never replaced, the editor still swallowed dropped launches, the ledger
signature missed verifies. Two of loop one's documentation repairs did damage (the drift log, a
typo). All of them are fixed here; loop 3 found the typo fix had missed (the phrase breaks across a
line) and finished it.

## The findings and what was done

*From*: dist = distributed-systems developer, sec = security engineer, fs = full-stack developer,
tw = technical writer, devops = DevOps engineer. *Sev*: H/M/L as the reviewer rated it. A finding
two reviewers made independently is one row naming both.

| # | From | Sev | Finding | Decision |
|---|---|---|---|---|
| 1 | dist, devops | H | A rotation that dies between the pointer flip and the drain leaves two active generations (the successor active at `/run`, the predecessor back to active after the 90 s lease); each terminates the other's cores every two minutes. The step timeouts exceeded the function's five minutes. | **Accepted.** `promote()` records `retiring` in the pointer and `retire()` clears it; a leftover is finished before `repair()`. The rotate function runs ten minutes and waits 120 s for RUNNING. When a lease runs out the control plane reads the pointer (`ControlPlaneDeps.pointer`, SSM in the image): named elsewhere at a higher generation, it drains and terminates itself (`rotation.test.ts`, two cases). A standby boot phase until `/adopt` is *deferred (loop 3)*: the adopt-once guard and phase-gated `latest` writes cover the successor side today. |
| 2 | dist | H | A result for an attempt the node never held settled an open task unless it carried an error; any visitor with the token could paint the frame or hijack the plan. | **Accepted.** An open task settles only from a known attempt, any outcome; unknown attempts may verify or contest settled tasks only (`results.ts`; `scheduler.test.ts` rewritten and extended). |
| 3 | dist | H | `defaultParams` was unbounded and every program's rode page 0; one dropped manifest could make every subscribe close with "frame too large". Programs were uncapped. | **Accepted.** `defaultParams` ≤ `PARAMS_MAX_BYTES` (4 KB) in the schema; `PROGRAMS_CAP` = 64 in `addProgram`; page 0 over budget strips `defaultParams` from the program views instead of closing; the page split is memoised per (generation, seq). |
| 4 | dist | M | A store fetch that threw was dispatched as `bytes: null`, which the ledger read as "missing" and failed the execution; loop one's retry never ran. | **Accepted.** `blobFetched` carries `error`; `onStoreError` counts it and leaves `waitingSince` so the `STORE_RETRY_MS` re-derivation retries; the execution fails only after `STORE_ERRORS_MAX` (6). |
| 5 | dist, sec | M/H | A core was linked or created from a self-declared `hostId`, and every snapshot published the ids; an impostor could get a real core terminated, starve the fleet, and blind the reaper. | **Accepted.** A random per-core token in the run payload (`cores.ts`), `hello.coreToken`, a hello links only a matching unlinked record and never creates one; `nodeView.hostId` is `"fleet"` for cores; `gone()` survives a bad id. |
| 6 | dist | M | `PRESIGN_BYTES_PER_CONN` was a lifetime cap: an honest Mandelbrot node hit 1 GiB within an hour and was closed as rate-limited. *Loop-1 regression.* | **Accepted.** A refilling bucket, `PRESIGN_BYTES_PER_MIN` = 64 MiB per connection. |
| 7 | dist | M | `latest.json.gz` was written while handing over and after drain, so a heal could boot from a drained predecessor; the adopt repeat guard compared `seq`. | **Accepted in part.** `snapshotNow` writes only while active (handover excepted); `/adopt` is accepted once per process (`adoptedOnce`). Keying snapshots so the fleet picks the highest generation is *deferred (loop 3)*: with the phase gate, `latest` is always the active lineage. |
| 8 | dist, devops | M | The client token `g<gen>-<hour>` replayed onto a terminated VM after a failed attempt in the same hour; nothing could launch until the hour turned. | **Accepted.** A run that resolves to a TERMINATED/TERMINATING VM is a replay: retried with `-r<n>`, three tries; the fake models the replay (`terminateNextRuns`); tests for the retry and for a leftover `retiring`. |
| 9 | dist | L | Inheritance resolves by execution id against 32 kept executions; a persist program's lineage is evicted within minutes of the loop. | **Deferred (loop 3).** A bundle → last done root map that survives pruning is a ledger change with its own snapshot field; the pruned-origin warning of loop 1 makes the loss visible meanwhile. |
| 10 | dist | L | Clients could take all sixteen endpoint connections; every `/handover` and `/drain` then got 429 and rotations degraded to snapshot handovers. | **Accepted.** `CLIENT_CONNECTION_CAP` = 14: the fifteenth client upgrade is refused with 503; §9.7 says so. |
| 11 | dist | L | `beginHandover` used `Date.now()` beside an injected clock, and a handover from a drained control plane resurrected it. | **Accepted.** `beginHandover(ledger, clock.now())`; `/handover` on a drained control plane is 409. |
| 12 | sec | H | A program that spins or aborts with text matching the host-failure regex was RELEASED for ever by every node: free, endless, unbounded `attempts`. | **Accepted.** A released attempt is charged `min(now, deadlineAt) − assignedAt` against `computeMsUsed`; after `RELEASES_PER_TASK_CAP` (6) releases the task fails as a program fault; `hostFailure()` returns false for anything starting `abort:`, `trap:`, or `link:` (test). |
| 13 | sec, fs | M/H | The solicited bucket charged one token per presign message of up to 64 items, each a HeadObject and a signature; and the schema's 64 against 256 writes per task plus an unguarded `presigned` frame made many-file tasks loop across the cluster on AWS. *Loop-1 regression.* | **Accepted.** One token per item; `maxPresignItems` = 24 in the schema (sized so 24 signed URLs fit one frame; `messages.test.ts` encodes a full reply); `StoreClient.putMany` presigns in batches of that cap, one round trip at a time; the `presigned` send is guarded like `send`. |
| 14 | sec | M | The store budget counted a self-declared size: a presign for "1 byte" accepted a 5 GB object whose key was its own hash. | **Accepted for the size.** `content-length` is a signed header on the presigned PUT (browsers and undici send it themselves; `signedHeaders()` leaves it out of the client map). A machine-wide hourly budget in `meta` and a shorter lifecycle for uploads are *deferred (loop 3)*: the per-connection refilling budget plus a signed size bounds one client. |
| 15 | sec | M | `RunMicrovm` was still image-wide for every launcher: the loop-one scoping ran only for a single-action list, and both call sites passed several. *Loop-1 regression.* | **Accepted.** Separate statements, `RunMicrovm` → the Tabframe image ARN, in the fleet and image stacks; `synth.test.ts` asserts no RunMicrovm statement names a wildcard image. |
| 16 | sec | M | One client could hold all sixteen connections, and a connect-subscribe-close loop re-serialised the snapshot each time. | **Accepted in part.** The 14-connection cap (row 10) and the memoised page split (row 3). Per-address caps need the client address: the control plane logs the upgrade headers once per process to learn whether the proxy forwards it; the cap itself is *deferred (loop 3)* until that is known. |
| 17 | sec | M | The control plane compiled untrusted WebAssembly (`new WebAssembly.Module`) on its event loop, against §2's "runs no program code". | **Accepted.** `readModuleShape()` parses the import and export sections from the binary; `validateModuleBytes(…, { compile: false })` on the control plane checks the allowlist and the required exports without compiling (three tests, including agreement with the compiled module). |
| 18 | sec | L | Cores carried the fleet secret; `/adopt` could turn a core into a control plane. | **Accepted.** `corePayload` sends no secret; `fleetAuthorized` is false for role core. |
| 19 | sec, devops | L/M | The base image tag and `nodejs22` were unpinned; two builds of one commit could differ. | **Accepted in part.** `FROM …@sha256:<digest>` (the digest looked up from the public registry) and `node --version` in the build log. A NEVRA pin for the RPM and a build-time Node assertion are *deferred (loop 3)*: the repository's exact package name changes with patch releases and a mismatch would fail every build rather than warn. |
| 20 | sec | L | The CSP existed only in CloudFront; the browser suites never ran under it. | **Accepted for the policy.** `PAGE_CSP` in the protocol package is shared by the CloudFront policy and the local server, which adds `http: ws:` for the loopback and sends `nosniff`. Tightening `connect-src` to the session and blob hosts is *deferred (loop 3)*: the hosts are per-deploy values the static policy does not know. |
| 21 | sec | L | Third-party actions pinned by tag. | **Accepted.** All four pinned by commit SHA with the tag in a comment. |
| 22 | fs | M | `BlobCache` re-fetched a missing hash every render with no backoff; the demo's `broken` program triggered it deterministically. | **Accepted.** `missingAt` with `MISSING_RETRY_MS` (10 s); the version is not bumped for a miss. |
| 23 | fs | M | The compile timeout left the hung worker in place; `died()` never terminated. *Loop-1 regression.* | **Accepted.** Timeout and death both terminate the worker and settle every pending compile; the next compile gets a fresh one. |
| 24 | fs | M | The editor said "launch sent" and "the machine runs your program" for a control the socket had merely held or dropped. *Loop-1 regression.* | **Accepted.** `send()` returns `"sent" \| "held" \| "refused"`; `onDropped` reaches `#launchInfo`; "launched" only on the `executionQueued` echo (`acknowledged`). |
| 25 | fs | M | A person's stop filled the red failure box; a page joining after a failure read "failed: failed". | **Accepted.** No `lastFailure` when the phase is `stopped`; `toExecutionState` keeps the wire's reason; the failure box is seeded from a snapshot whose execution failed (`seededFailure`). |
| 26 | fs | M | The demo store grew without bound: ten megabytes a frame for as long as the tab lived. | **Accepted.** `BoundedBlobMap`, 1500 blobs, reads refresh an entry, so the seeded files stay and stale tiles go. |
| 27 | fs | M | The source box trapped Shift+Tab; file and ledger rows were click-only. | **Accepted.** Shift+Tab leaves the field, Escape releases focus, rows are `tabindex="0" role="button"` with Enter and Space. |
| 28 | fs | L | A node that met `off` never asked again; a tab that lived through `down` and `up` lent no core until reload. | **Accepted.** The orchestrator polls an off machine every `OFF_POLL_MS` (15 s) (test). |
| 29 | fs | L | "resume updates (N held)" counted renders, not states. | **Accepted.** Counted per arriving `seq`. |
| 30 | fs | L | The activity list was rebuilt every frame and promised "a few hundred lines" with a cap of 60. | **Accepted.** Redrawn when `(length, last seq, last time)` changes; `ACTIVITY_CAP` = 400. |
| 31 | fs | L | The ledger signature missed a verify or a mismatch on any row but the newest. *Loop-1 regression.* | **Accepted.** `counters.verified` and `counters.mismatched` are in the signature. |
| 32 | fs | L | Unhashed bundles served `immutable` for a year locally; the web stack set no `Cache-Control`. | **Accepted for the caching.** Pages, styles, scripts, and JSON are `no-cache` locally; the bucket deployment sets `no-cache` on every object. Content-hashed bundle names are *deferred (loop 3)*: nothing is immutable until they exist. |
| 33 | devops | H | A bare `cdk deploy` published the placeholder image as the newest version; the next rotation booted a control plane with nothing in it. | **Accepted.** `stagingDirOrRefuse()` defaults to `image-dist` and refuses the placeholder unless `TABFRAME_IMAGE_PLACEHOLDER=1`; `deploy:stacks` deploys the staged image and runs `up`; the runbook points at it. |
| 34 | devops | M | `build.json` was staged but never copied into the image; `/health.build` was always null. *Loop-1 regression.* | **Accepted.** `COPY build.json` in the Dockerfile; `dockerfile.test.ts` checks the COPY set against what `stage-image.ts` stages. A `health` failure on a null build is *deferred (loop 3)*. |
| 35 | devops | M | Rollback was a hand edit of the function's environment; cores launched at the latest version regardless. | **Accepted in part.** `mise run rollback -- <version>` pins the rotate function's `TABFRAME_IMAGE_VERSION`, waits for the update, and rotates; `-- --clear` removes the pin; the runbook describes it. Carrying the version through the run payload so cores follow the pin is *deferred (loop 3)*: the control plane does not learn its own image version from the platform today. |
| 36 | devops | M | No `cdk diff`, `--require-approval never`, and CI never synthesised the real app. | **Accepted.** `deploy:iam-gate` runs `cdk diff --all --security-only --fail` before the stacks (`TABFRAME_DEPLOY_IAM=1` acknowledges a reviewed broadening); CI synthesises all four stacks with the placeholder image and no credentials. |
| 37 | devops | M | No external heartbeat: a 403 page or a heal stuck in `starting` was invisible. | **Accepted.** `tabframe-canary` (128 MB, 10 s, every five minutes) fetches `config.json` and the session URL, records `PageOk`/`SessionOk`/`Starting` under `Tabframe/Canary`, and never touches the MicroVM endpoint; alarms for the page, the session, and fifteen minutes of `starting` mail the topic; the runbook notes the subscription must be confirmed. |
| 38 | devops | L | `AWS_PROFILE` and `.env.local` were global: tests and the sim ran as admin. | **Accepted.** Per-task `env` on the ten AWS tasks; `_.file` alone on `transcripts`. |
| 39 | devops | L | The guard accepted any old commit on main, checked no CI, and ran after the build. | **Accepted.** HEAD must equal `origin/main`, its CI run must be green (`gh run list`), the guard runs first; `build.json` records `branch` and `ungated`. |
| 40 | devops | L | Rule-target retries governed EventBridge delivery, not the function; a changed rule resource re-disabled the schedule. | **Accepted in part.** `configureAsyncInvoke` on rotate (two retries, thirty minutes). Creating the rule enabled is **rejected**: D20 keeps the schedule off until `up`, and every deploy path (`deploy`, `deploy:stacks`) ends with `up`, which enables it. |
| 41 | tw | H | Loop one's drift-log repair deleted a clause and fused seven entries into one line. | **Accepted.** §17 rebuilt from the pre-loop text; only the duplicated paragraph removed; the Freeze sentence back in WP1.9; entries noted as merge order. |
| 42 | tw | M | "is the an extension" in the README's limits paragraph. | **Accepted.** |
| 43 | tw | M | "Core" meant three things across README, footer, hints, glossary, and R6. | **Accepted.** R6 amended — a core is any worker, a cloud core the MicroVM kind, a node the ledger's word for a joined core — and the glossary follows; the README, footer, and hints already read that way. |
| 44 | tw | M | "About fifteen tabs" in four documents; a lending tab costs two connections. | **Accepted.** "About seven tabs that each lend a node, or fifteen that only watch" in README, §9.7, the rationale, and the M3 verification. |
| 45 | tw | M | The loop-one note said "three seconds", cited a diff that did not exist, and carried totals its table could not produce. | **Accepted.** Two seconds; the guide cut named where it lives (`editor-core.ts`); counts derived from the table and carried into the plan and the index; a legend. |
| 46 | tw | M | Nine technical-writer findings shared one row; nothing listed what loop two owed. | **Accepted.** Rows 44–52 written out; a "Deferred to loops 2–3" list. |
| 47 | tw | M | The guide's cut at "## Compiling" also dropped the allowed imports and the NaN caveat. | **Accepted.** Both moved above the cut in the SDK README; the embedded sources regenerated. |
| 48 | tw | M | The runbook did not know the deploy guard or the `/health` build fields. | **Accepted.** The deploy row names the guard, the escape hatch, and the diff gate; `/health` lists `build` and `imageVersion`. |
| 49 | tw | M | The walkthrough missed the reloaded-once state. | **Accepted.** A row for it, with the banner's hint and the visitor's action. |
| 50 | tw | L | Stale runbook facts: the snapshot lifecycle, the alarm-test chore, the topic only in an incident row, a repeated parenthetical. | **Accepted.** All four. |
| 51 | tw | L | "Spawn 3" against a button that reads "spawn N"; the third program in a separate "Since M6" paragraph. | **Accepted.** "spawn N" with what N is; one paragraph of three programs. |
| 52 | tw | L | The plan's "where we are", the rationale's "M0 to M7", the design's stale `mise.toml` copy, "§6.7 below" from inside §6.7. | **Accepted.** All four; §11.2 now points at the file and describes its shape. |

## Deferred to loop 3

- 1 (in part): A standby boot phase until `/adopt` is *deferred (loop 3)*: the adopt-once guard and phase-gated `latest` writes cover the successor side today.
- 7 (in part): Keying snapshots so the fleet picks the highest generation is *deferred (loop 3)*: with the phase gate, `latest` is always the active lineage.
- 9 (whole): Inheritance resolves by execution id against 32 kept executions; a persist program's lineage is evicted within minutes of the loop.
- 14 (in part): A machine-wide hourly budget in `meta` and a shorter lifecycle for uploads are *deferred (loop 3)*: the per-connection refilling budget plus a signed size bounds one client.
- 16 (in part): Per-address caps need the client address: the control plane logs the upgrade headers once per process to learn whether the proxy forwards it; the cap itself is *deferred (loop 3)* until that is known.
- 19 (in part): A NEVRA pin for the RPM and a build-time Node assertion are *deferred (loop 3)*: the repository's exact package name changes with patch releases and a mismatch would fail every build rather than warn.
- 20 (in part): Tightening `connect-src` to the session and blob hosts is *deferred (loop 3)*: the hosts are per-deploy values the static policy does not know.
- 32 (in part): Content-hashed bundle names are *deferred (loop 3)*: nothing is immutable until they exist.
- 34 (in part): A `health` failure on a null build is *deferred (loop 3)*.
- 35 (in part): Carrying the version through the run payload so cores follow the pin is *deferred (loop 3)*: the control plane does not learn its own image version from the platform today.

## Tests

- Core: the evidence gate and released accounting (`scheduler.test.ts`), the trap-snapshot regression (`programs.test.ts`), per-item presign tokens (`apply.test.ts`), one launch per ack (`fleet.test.ts`), page 0 with sixty-four heavy programs fits (`review-loop-2.test.ts`); 131 pass. The whole unit suite is 543 tests.
- Protocol: a full `presigned` reply encodes within one frame. Store: the signed content length. Sandbox: the section parser agrees with the compiled module, the no-compile path names a forbidden import, a truncated section is malformed. Node: an off machine is asked again; program faults are never host failures.
- Control plane: a control plane whose lease ran out drains and terminates itself when the pointer names a newer generation, and carries on when it does not (`rotation.test.ts`); the core payload carries the token and no secret.
- Fleet: a leftover `retiring` is finished first; a replayed token is retried with `-r1`; 66 pass.
- Infra: the Dockerfile copies what is staged and pins by digest; the canary, its rule, its metric-only policy, and its alarms; no RunMicrovm statement names a wildcard image; the rotate timeout.
- Every browser suite passes locally under the deployed content security policy; the CDK app synthesises without credentials (as CI now does).

## Drift

`docs/design.md` §17 entry of 2026-09-04 (WP8.2); §9.7 (the connection cap), §11.2 (points at `mise.toml`), §16 (the vocabulary); the README, runbook, walkthrough, rationale, plan, and the loop-one note as listed in rows 41–52.
