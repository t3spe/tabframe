# WP9.5 — The deep review: structure and anti-patterns, and the refactors that followed

**Branch** `wp/9.5-*` (five branches, one per package group) · **Milestone** M9 · **Date** 2026-09-04/05 ·
**Ask** Mircea: review the code deeply for anti-patterns and for structural improvements that can be
made across the board; and, in the code, make the comments brief and explain the why, not the what.

## Method

Five fresh reviewers, one per package group, read the tree after loops one to three with the same
checklist — module size and cohesion, duplication, module-level mutable state, fire-and-forget
promises, error strings parsed by regex, casts, optional fields used as state machines, naming
against the settled vocabulary, tests that pin rather than prove, package boundaries — and each
returned at most fifteen findings with a concrete refactor and a proposed module map. The findings
were accepted or deferred as below; then five implementers, one per group, each in its own git
worktree and branch, carried the accepted findings as behaviour-preserving refactors with the
suites as the net, and reduced comments to the why in every file they touched. The branches merged
into `main` one at a time, each with typecheck, lint, the unit suites, a synth, and CI green. The
reviews are kept beside this note's sources; the tables below say what each finding became.

The comment rule, now checked in CI (`tests/comments.test.ts`): a comment states a constraint, an
invariant, or a non-obvious consequence; no work-package tags, no dates, no "used to" or "found by";
a design-section reference stays because it points at the reasoning.

## Web (`packages/web`, `e2e/`) — 15 findings

| # | Finding | Outcome |
|---|---|---|
| 1 | `host.ts` was a 1,204-line program that ran at import: 23 module-level `let`s, forward references, dead exports, no unit tests | **Done.** `host.ts` is a 109-line entry (`readPageMode` → `mountDashboard` → `main().catch(showFatal)`); state lives in `dashboard.ts` and the view modules (`canvas`, `chart`, `header`, `notice`, `local-nodes`, `nodes-table`, `activity-view`, `demo/store`). |
| 2 | `panels.ts` was one 980-line closure with eight shared selection variables; the blob cache was untestable in isolation | **Done.** `blob-cache.ts` with its own tests; `panels/*` (ten files) over one `PanelContext` and a shared `Selection`. |
| 3 | Helpers defined twice or thrice (`fmtTime`, `fmtBytes` in KB and KiB, `$`, `HASH_RE`, the counter labels, three notice timers) | **Done.** `dom.ts`, `format.ts` (KiB everywhere), `notice.ts`, `params.ts`; `HASH_RE` from the store package. The two timeouts the node package also defines stay duplicated: the node does not export them from a leaf module. |
| 4 | Implicit state machines in the editor: three variables that had to agree for a loaded module, five for a launch | **Done.** `LoadedModule` and `Launch` unions; `EditorHost.launch()` returns `"sent" \| "held" \| "refused"`; the editor page's hold is a three-state value. |
| 5 | `demo.ts` mixed the simulated machine with the story, used real timers despite an injected clock, and swallowed rejections | **Done.** `demo/content.ts`, `demo/machine.ts` (injected timers and hash), `demo/story.ts`; rejections land in an error message; `demo.test.ts` drives the demo under a manual scheduler and asserts the numbers the browser suite pins. |
| 6 | `state.ts` had three reasons to change: reducer, selectors, visitor copy | **Done.** `cluster-state.ts`, `selectors.ts`, `copy.ts` (banners.ts renamed); the tests split the same way. |
| 7 | Types flowed the wrong way (the worker entry defined the editor's message types); undeclared dependencies | **Done in part.** `compiler-types.ts`, `controls.ts`, `canvas.ts`; `assemblyscript` and the SDK declared. The seeding-parity test still imports the control plane by path. |
| 8 | Strings used as state: `"stopped by a person"` compared in three packages; the editor read a refusal out of the activity log | **Deferred.** A protocol constant and a `lastError` field touch core and protocol; recorded for the next pass. |
| 9 | `window.tabframe` untyped and cast in twenty places | **Done.** `debug.ts` with `declare global`; the browser suites use a typed accessor. |
| 10 | Nine browser suites, no shared helpers | **Done.** `e2e/helpers.ts`. |
| 11 | Unit tests patched globals and hand-rolled fixtures | **Done.** `ObserverClient` takes `{random, now, fetch, socket}`; `fixtures.ts`. |
| 12 | Tests that cast rather than prove (`as never` eleven times) | **Done.** `taskOf()` throws when absent; `toExecutionState` exported; shared builders. |
| 13 | Async paths with no landing (`void main()`, paints outside the `try`) | **Done.** `main().catch(showFatal)` in both entries; tiles paint in a `try/finally` that pumps. |
| 14 | Vocabulary on the page: the wire's `core` printed for a MicroVM; "cores" meaning CPU threads | **Done.** `kindLabel()` prints "cloud core" / "tab"; the spawn hint says CPU threads; the footer says every open tab is a core. The wire enum is untouched. |
| 15 | Comments narrated history (27 work-package tags in `host.ts` alone; misplaced docstrings) | **Done** in every touched file. |

## Control plane, node, store — 15 findings

| # | Finding | Outcome |
|---|---|---|
| 1 | `createControlPlane` was an 840-line closure over fifteen `let`s; nothing testable without two listeners and a socket server | **Done.** A 280-line composition root over `state`, `effects`, `sockets`, `authority`, `lifecycle`, `run-hook`, `rotation`, `routes-public`, `routes-private`, `fleet-gate`, `health`, `loops`, `http`, `self-test`, `resolutions`, `snapshot-policy`, each taking its dependencies as parameters. |
| 2 | Twelve fire-and-forget promise chains; `close()` did not wait for them; tests polled | **Done.** `inflight.ts` tracks every executor promise; `dispatch` is a no-op after `close()`, which awaits them; `ControlPlane.idle()` for tests. |
| 3 | `hostFailure()` matched error *messages* the repository itself authors one package over | **Done.** `StoreError { kind, status }` from the store; the node releases on `instanceof StoreError`; the regex keeps only the sandbox's own strings. Follow-up recorded: a typed `TaskResult.reason` from the sandbox so the last regex can go. |
| 4 | One flat `Config` for two modes, with six image-only nullables and three `as string` casts | **Done.** `Config = LocalConfig \| ImageConfig`; `testing.ts` `testConfig()` replaces three 23-field literals. |
| 5 | The process imported the Lambda package for one SSM reader and built its AWS adapters itself | **Done in short form.** `deps.pointer` and a `deps.coreFleet` factory wired in `main.ts`, the only file importing fleet; `imageVersion()` is a getter, not a mutated config. A shared platform package is deferred. |
| 6 | Duplicated wiring: the node's platform entry copied into the control plane's core-node; S3 helpers twice; a base64 decoder twice | **Done in part.** `node-deps.ts` shared; `s3-common.ts`. `fromBase64` and `SocketPresigner` stay where they are (cross-package moves deferred). |
| 7 | `Orchestrator` held twenty fields across two concerns with two overlapping reset paths | **Done.** `NodeConnection` + `TaskLoop`; `Orchestrator` composes them; `TaskRunner.run()` drops its unused `gen`. |
| 8 | Seeding interleaved store writes with the pure reconciliation, testable only over HTTP | **Done.** `reconcileSeed()` pure and tested in-process. |
| 9 | Retries hard-coded and untestable; only GET had a timeout | **Done.** `retry.ts` with an injectable policy; GET and PUT both bounded (PUT was unbounded); an options-object constructor with the positional form kept. |
| 10 | `onRun` returned a bare boolean; the reason was lost | **Done.** `{ ok, role } \| { ok: false, reason }`; the 400 body carries the reason. |
| 11 | `/health` and `/diag` built ninety lines of JSON inline; the build stamp smuggled through `process.env` | **Done.** `health.ts` with typed `HealthReport`; `build` through deps. Keys unchanged. |
| 12 | Four suites re-implemented "spawn the process and wait for `listening`"; literals pinned instead of constants | **Done.** `testing.ts`; constants named. |
| 13 | Three gates for one `latest` write | **Done.** `snapshot-policy.ts` `mayWriteSnapshot()`, table-tested. |
| 14 | An if-chain of routes with a hand-kept fleet-gate set; the drain sequence twice | **Done.** A route table with `fleet` as a property; one `letClientsGo()`. |
| 15 | Casts around `WebSocket` and positional upload results | **Done.** `webSocketLike()`; `putNamed()`. |

A latent bug the implementer preserved and flagged — the control plane asked the platform for its
own image version before its fleet existed, so the answer never came in production — is fixed in
WP9.6 with a test.

## Core (`packages/core`) — 15 findings

| # | Finding | Outcome |
|---|---|---|
| 1 | The store answer an execution was waiting for was implicit in a tuple of five fields, re-derived in two places that had already drifted | **Done.** `ExecutionRecord.awaiting { purpose, since, errors }`; one `issue()` builds every store effect, one `answered()` guards every handler; `resumePending` reissues the recorded purpose; old snapshots derive it once on read. |
| 2 | `Meta` mixed durable and per-process state; `deserializeLedger` hand-reset six fields with magic numbers duplicated in two files | **Done.** `Ledger.session` via one `freshSession()` used by create, deserialize, and adopt; `Meta` is durable only. The socket maps stay top-level because `/health` reads them. |
| 3 | `apply.ts` (915 lines) held the dispatcher, the wire gate, controls, the handshake, pages, liveness, and budgets, with constants declared after use | **Done.** `apply.ts` is 151 lines; `connections`, `node-messages`, `controls`, `pages`; `executions.ts` became `execution`, `loop`, `programs`, `retention`, `advance`. The import direction is acyclic and stated. |
| 4 | Three ending paths disagreed about who advances the machine; the launch path was written three times | **Done.** One `endExecution` (finish/fail/cancel are wrappers that do not kick), one `advance()` at the tail of every handler that kicks, one `launchFor`. Effect order preserved: fourteen simulation trace hashes are identical to the baseline. |
| 5 | Three token-bucket functions over one shape with two rate units and seeds in three places | **Done.** `budgets.ts`: `Bucket`, `perSecond`/`perMinute`, `BUDGETS`, `take`, `chargePresign`, `chargeLaunch`, `coolingDown`. |
| 6 | Task transitions and their counters written by hand in 24 places across six files | **Done.** `tasks.ts` owns `newTask`, `setStatus` (counters from the transition), `releaseTask`, `failTask`, `cancelOthers`, `runningAttempts`, `stageTasks`; the invariants check the `done` and `failed` counters and `sealedStage <= stage`. |
| 7 | One purpose union for two channels; three outcomes in two fields; optional fields every producer supplied; a refusal disguised as a store request | **Done.** `FetchPurpose`/`PutPurpose`; `fetchResult()` reads the control plane's `bytes`/`error` shape; `token` and `files` required; the machine-budget refusal to a node is a `presigned` frame with no URLs. |
| 8 | Optional fields as state names (`unlinkedAt?`, `token?`, `heartbeatAt?`, `retired?`) | **Done in part.** Nullable fields with migration on read; the cloud core's token is required. A `link` union, `retired: boolean`, and one `sleeping` field need the control plane's health module and a test literal: deferred. |
| 9 | "Core" meant the MicroVM kind inside the package that is itself called core | **Done within the constraints.** `CloudCoreRecord`, `cloudCoreLaunched`/`Gone`, `CLOUD_CORE_*`, `forgetCloudCore` (replacing four delete-and-terminate pairs), `WorkerKind`, `yieldLoop`/`unyieldLoop`; `ledger.cores`, `meta.*`, and every event and effect kind string kept for the control plane. |
| 10 | A `scheduler` ↔ `results` import cycle; re-export lines that existed to appease the linter | **Done.** `policy.ts` holds every constant with its § reference; the cycle and the re-exports are gone. |
| 11 | A private copy of the harness; helpers duplicated across suites; tests named after the review that wrote them | **Done.** Tests redistributed to `execution`, `controls`, `results`, `scheduler`, `pages`, `retention`, `apply`, `handover`; the harness gained `planAssign`, `stage`, `completeFrame`, and `assigns` with deadlines. Still 136 tests. |
| 12 | The harness owned its ledger for life, so nothing could adopt in place — the mid-run rotation the loops wanted to simulate was structurally impossible | **Done.** `harness({…})` with `h.adopt(json, gen)`; the store-retry tests adopt in place; the simulation's world reads through it. |
| 13 | `World` was transport, process, property checker, stats sink, and phase driver in one; the documented leniency was structural | **Done.** `sim/process.ts`, `sim/properties.ts`, `sim/wire.ts`; `Scenario` knobs `deadlineEnforced`, `storeFailRate`, `duplicateRate`, `rotateAfterMs` exist and are off. A probe with them on ran clean except `duplicateRate`, which surfaces duplicate-hello closes: the first row of the recorded follow-up. |
| 14 | Seventy exports of which the control plane used fourteen; the simulation bypassed the index; two `Rng` shapes | **Done.** `index.ts` is the process API; `@tabframe/core/testing` for the harness and the simulation; `Rng`/`Store`/`Transport` deleted. `bytes.ts` stays until the base64 helpers move to protocol. |
| 15 | A module-level page memo in a package whose contract is "no state outside the ledger"; the cluster serialised twice per subscribe | **Done.** The memo lives in `session`; one serialisation; one `latestExecution()`. |

## Fleet, infra, tooling — 15 findings

| # | Finding | Outcome |
|---|---|---|
| 1 | `rotate.ts` was one 400-line closure; heal and rotate pasted the same launch block; ten inline pointer writes | **Done.** `rotate/{index,policy,launch,pointer-ops,retire,repair}.ts`; one `launchSuccessor`; `pointer-ops.ts` is the only pointer writer; the policy is two pure functions because the original checked them at two points. New tests without fakes. |
| 2 | Operator scripts bypassed the fleet adapters and re-implemented them with raw SDK calls; three scripts had no identity guard | **Done.** `fleet/src/operator.ts` asserts the identity at import; `health.ts` runs on the pointer store and the control-plane client; every probe imports the fleet modules. The secret's ARN comes from the stack's resource id rather than a new output (no template change). |
| 3 | Names, ports, region default, and Lambda environment keys as independent literals in three places | **Done.** `fleet/src/names.ts` and `env.ts` (typed key tuples); a synth test asserts each function's variables equal its tuple. |
| 4 | The app entry mixed env reads and two policies with stack construction; the synth test wired its own graph | **Done.** `lib/app-config.ts` (pure, tested) and `lib/app.ts`; `bin/tabframe.ts` is one line; the guard imports the budget rule. |
| 5 | The launcher IAM shape written twice; three function definitions and three alarm shapes repeated | **Done.** `lib/grants.ts`, `lib/fleet-function.ts`, `lib/canary.ts`; the synthesised templates are byte-identical before and after (asset hashes aside). |
| 6 | Two deploy paths in `mise.toml` that could drift; a `bash -c` gate; tasks unordered | **Done.** `deploy` = guard → build → test → gate → `deploy:stacks`; `iam-gate.ts`; the file ordered; descriptions without milestone prefixes. |
| 7 | CI never built the page or the image and duplicated its setup steps | **Done.** A `ci` task the workflow calls; a shared setup action; the stale simulation guard gone; CI now builds the web bundle and the image stage. |
| 8 | Tests parsed `mise.toml` and the Dockerfile by regex against hardcoded copies | **Done.** `mise.toml` imported natively; `stageImage()` importable with `STAGED_FILES`. |
| 9 | Environment reads outside the config modules; an untested S3 adapter in a Lambda entry | **Done.** `RotateConfig.snapshotBucket`, `loadCanaryConfig`, `S3SnapshotIndex` tested with the mock. |
| 10 | The fake MicroVM client's four interacting knobs | **Done.** A FIFO of `RunPlan`s. |
| 11 | Operator logic in entry scripts | **Done.** `pin()` and `rotateNow()` in `ops.ts` with tests. |
| 12 | Four verification runbooks re-declaring their headers and footers | **Done.** `_runbook.ts`; the check bodies are verbatim. |
| 13 | Casts and shape copies | **Done.** |
| 14 | Masking implemented in three places | **Done.** `fleet/src/mask.ts`. |
| 15 | `CoreStack` beside `coreRole` beside `packages/core` | **Done.** `FoundationStack`, `cloudCoreRole`; every CloudFormation id, output, and variable name unchanged. |

A wart the implementer preserved and flagged — after finishing a leftover retire the handler kept
the stale pointer read, so a later write could briefly resurrect the cleared record — is fixed in
WP9.6 with a test.

## Protocol, sandbox, SDK, programs — 14 findings

| # | Finding | Outcome |
|---|---|---|
| 1 | The SDK's test host was a second, divergent implementation of the ABI glue, so the goldens never exercised production code | **Done.** The host runs programs through the sandbox's `runTask`; the goldens hash identically. |
| 2 | Schema fragments spelled out repeatedly (the presign items twice — how the 64-versus-24 drift of loop 2 happened) | **Done.** Shared fragments in `shared.ts`; field names and the protocol version unchanged. |
| 3 | Three LEB128 readers; the validator walked the binary twice; a nullable `module` forced casts | **Done.** `wasm-binary.ts` (`ByteCursor`, `readModuleSections`); `inspectModuleBytes` and `compileValidated`; the old entry kept for its callers. |
| 4 | Four ways to obtain a compiled program; the SDK suite recompiled everything each run | **Done.** `programs.ts` (`@tabframe/sdk-as/programs`) with a staleness check; the suite is twice as fast. The control-plane fixtures and the simulation loader migrate in a later pass. |
| 5 | The same limits in three unrelated objects; "memory maximum" meant two things | **Done.** `SPEC_LIMITS` derived from `LIMITS`; `sdk-as/flags.ts` holds the compiler flags and the 256-page reference. `DEFAULT_TASK_LIMITS` in core is untouched. |
| 6 | The "byte for byte" mirroring was tested through one echo fixture | **Done.** Property tests over tables, strings, bars; magics asserted from emitted bytes. |
| 7 | Four decoders repeating their preamble; a bare `AbiError` | **Done.** `abi-bytes`, `abi-inputs`, `abi-spec`, `abi-bars`; `AbiError` with `code` and `at`. Run and plan decoders stay lenient. |
| 8 | Both worker entries repeated the serve loop; `storeBase` travelled in an untyped bag | **Done.** `adapters/serve.ts`; a typed field. |
| 9 | Multi-stage programs re-implemented "read the previous stage's outputs" | **Done in part.** `fs.outputs`, `fs.readOrAbort`, `Params.getI32In`; wordcount uses them with identical output bytes. tinygpt's collect loop keeps its silent `break` (changing it is a behaviour decision). |
| 10 | Tests named after the process that wrote them | **Done** in these packages; the core's review-loop files are the core pass's. |
| 11 | Pinned values and property tests far from the caps | **Done.** `arbitraries.ts` with an at-the-caps mode; the trap test produces a trap. |
| 12 | The SDK flattened the sandbox's return codes | **Done.** `RC`, `fs.readRc`, `fs.writeRc`, pinned against the sandbox by a compiled probe. |
| 13 | A deployment constant in the wire package built by string replacement | **Done in part.** `pageCsp(region, { local })` builds from sources; the constants stay for their callers. |
| 14 | Narration and stale README prose | **Done** for comments; the SDK README and `e2e/README.md` were corrected in WP9.2 and WP9.6. |

## Deferred, with reasons

- **Web 8** — a protocol constant for "stopped by a person" and a `lastError` field on the cluster
  state: touches core and protocol; next pass.
- **Control plane 5 (long form)** — a `@tabframe/platform` package for the MicroVM client, the pointer
  store, and the connector ARNs that both the process and the Lambdas depend on: changes the
  workspace graph; the `main.ts` wiring is enough for now.
- **Control plane 6 (part)** — `fromBase64` to the protocol package and `SocketPresigner` to the
  store package for the page's observer to share: cross-package moves; next pass.
- **Control plane 3 (follow-up)** — a typed `TaskResult.reason` from the sandbox so the last regex in
  `hostFailure()` can go.
- **Fleet 2 (part)** — a `FleetSecretArn` stack output: a template change the pass forbade itself;
  the resource id serves.
- **Fleet 9 (part)** — `snapshotBucket` required and the `latestSnapshotKey` alias dropped once the
  control plane's handover test moves to `snapshots`.
- **Protocol 4, 5, 13 (parts)** — the control plane's fixtures, the simulation's program loader, and
  the page's editor onto `@tabframe/sdk-as/programs`, `inspectModuleBytes` / `compileValidated`, and
  `flags.ts`; `DEFAULT_TASK_LIMITS` derived from `LIMITS`; the `PAGE_CSP` constants replaced by
  `pageCsp(region)` at their two callers: each a small cross-package edit; next pass.
- **Protocol 9 (part)** — tinygpt's collect loop breaks silently on a missing output where wordcount
  aborts: making it abort is a behaviour change for a decision, not a refactor.
- **Core 8 (parts)** — a `link` union on the cloud-core record, `retired: boolean`, and one `sleeping`
  field: each needs the control plane's health module or a test literal to change with it.
- **Core 14 (part)** — `toBase64`/`fromBase64` to the protocol package (the node has a copy).
- **Core 13 (the knobs)** — the harsher simulation itself: the knobs exist and are off; turning them
  on is the recorded follow-up (D8), and its first finding is already known — duplicated hellos close
  a socket.

## Gates

Each branch: typecheck, lint with no errors, its package suites, and its specific net (the browser
suite for the web; two simulation seeds and the control-plane suite for the core; a template
snapshot for the stacks; the program goldens for the SDK). Each merge into `main`: the three
typechecks, lint, the whole unit suite, a synth, and CI green. After the five merges: 679 unit tests pass (560 before the pass, with 136 in core unchanged), lint reports no errors, the three typechecks are clean, the app synthesises without credentials, and CI is green on every merge commit.
