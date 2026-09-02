# WP0.9 — Fleet skeleton

**Milestone:** M0 · **Branch:** `wp/0.9-fleet-skeleton` · **Package:** `packages/fleet`

## What

The two fleet functions and the operator scripts from design §9.2, in their v0 shape:

- **`session`** (public function URL, GET): reads the pointer; serves `{off: true}` when the machine is off; otherwise looks up the control plane and returns `{endpoint, token, expiresAt, storeBase, generation}`. One shared token per control plane, minted for 30 minutes and re-minted after 25, scoped to port 8080 only. When no control plane is running it invokes `rotate` asynchronously to heal, at most once per 10 seconds per warm instance, and answers `{starting: true, retryAfterMs}`. CORS for GET and OPTIONS from the page origin.
- **`rotate` v0** (hourly EventBridge rule, also invoked by `session`): idempotent. Off → nothing. A control plane that is pending, running, or suspended → nothing (the hourly handover is WP3.2; the seam is marked with a TODO). Otherwise it launches a control plane from the image with the design's run-hook payload (`role`, `generation`, `snapshotKey: null`, `sessionUrl`, `storeBase`, `fleetSecret`), the AWS-managed `ALL_INGRESS` and `INTERNET_EGRESS` connectors, the idle policy (suspend after 15 idle minutes, auto-resume, terminate after 7 suspended hours), an 8-hour maximum duration, and a deterministic client token per generation; backs off on `ThrottlingException` (1, 2, 4, 8 s); polls until `RUNNING` within a bounded window; then writes the pointer.
- **Operator scripts** `scripts/rotate.ts`, `scripts/up.ts`, `scripts/down.ts` behind the `mise run` tasks: `up` writes `on`, enables the schedule, and invokes rotate; `down` disables the schedule, terminates every MicroVM from our image, and writes `off` (decision D20). Output is masked.
- A **pointer** model: one SSM parameter holding `{state, microvmId, endpoint, generation, imageVersion, updatedAt}`, parsed tolerantly so the CDK initial value `{"state":"off"}` and any malformed value degrade to the empty pointer.

## How

- Every AWS surface sits behind an interface in `src/types.ts` (`MicrovmClient`, `PointerStore`, `Invoker`, `RuleControl`, `SecretReader`, `Clock`, `Sleeper`, `Logger`). The handlers are factories that take those dependencies, so the logic is tested with the in-memory fakes in `src/testing/fake.ts` (a MicroVM fleet with configurable throttling, boot polls, and failed boots; a fake clock and sleeper; a recording invoker).
- The real adapters are field mapping only: `src/microvm-client.ts` over `@aws-sdk/client-lambda-microvms` (field names taken from the SDK's own type definitions: `imageIdentifier`, `ingressNetworkConnectors`, `runHookPayload`, `authToken["X-aws-proxy-auth"]`, states `PENDING|RUNNING|SUSPENDED|SUSPENDING|TERMINATED|TERMINATING`), and `src/aws.ts` for SSM, Lambda invoke, EventBridge rules, and Secrets Manager. They are tested with `aws-sdk-client-mock`, so command inputs and output mapping are covered without an account.
- `src/lambda/session.ts` and `src/lambda/rotate.ts` are the Lambda entry points; `scripts/_deps.ts` wires the same adapters for the operator. Configuration comes from environment variables in `src/config.ts` with defaults for names and required checks for ARNs and URLs.
- The fleet secret is not an environment variable. `rotate` reads it from Secrets Manager at invocation (`TABFRAME_FLEET_SECRET_ARN`) and passes it in the run-hook payload, so it exists only in the secret store and inside the MicroVM.

## Why

- **Interfaces plus fakes, not mocks everywhere** (design §12): the handlers' branches are the interesting part and they run in milliseconds against fakes; the adapters are trivial and get the SDK mock so their mapping is still proven.
- **Shared token** (design §9.2, review item 6): tokens are not per client, so one mint per 25 minutes serves everyone, which is what makes the account's Lambda concurrency default of 10 a non-issue together with the rotation jitter.
- **Heal is asynchronous with a cooldown**: the visitor gets an immediate "starting" answer and rotate, with its reserved concurrency of one and idempotent check, launches exactly one control plane no matter how many visitors arrive at once.
- **Client token per generation**: RunMicrovm is idempotent on `clientToken`, so a retried launch after a throttle or a crash cannot produce two control planes for one generation.
- **Off is a first-class state** (D20): `down` writes it, `session` honors it, `rotate` refuses to launch under it, and only `up` clears it.
- **Secrets Manager for the fleet secret**: CloudFormation cannot create SecureString SSM parameters, and a generated secret must never be committed or logged; a managed secret read at invocation is the smallest correct answer.

## Evidence

- `bun test packages/fleet` → 43 pass, 0 fail, 144 assertions across 6 files; coverage 99.3 % lines (`aws.ts`, `config.ts`, `microvm-client.ts`, `ops.ts`, `pointer.ts`, `rotate.ts`, `session.ts` all 100 %).
- `mise run lint` → Biome clean, `tsc --noEmit` clean under `exactOptionalPropertyTypes` and `erasableSyntaxOnly`.
- Branches covered: off state; heal once per cooldown; cached token reuse and re-mint at 25 minutes; token cache invalidated by a new control-plane id; suspended served, pending reported as starting, terminated and missing heal; endpoint fallback to the pointer; CORS preflight and method rejection; rotate off / running / stale pointer / first launch / poll until RUNNING / throttle backoff / backoff exhausted / boot timeout / boot terminated; `up` and `down`; SSM not-found and error propagation; SDK input mapping, pagination, token extraction, port specs; invoke async and sync incl. function errors; rule enable and disable; secret read.

## Dependencies introduced

| Package | Version | Why |
|---|---|---|
| `@aws-sdk/client-lambda-microvms` | 3.1124.0 | run, get, list, terminate, suspend, resume, auth tokens |
| `@aws-sdk/client-ssm` | 3.1124.0 | the pointer parameter |
| `@aws-sdk/client-lambda` | 3.1124.0 | `session` invokes `rotate`; operator scripts invoke functions |
| `@aws-sdk/client-eventbridge` | 3.1124.0 | `up`/`down` enable and disable the hourly rule |
| `@aws-sdk/client-secrets-manager` | 3.1124.0 | `rotate` reads the fleet secret |
| `aws-sdk-client-mock` (dev) | 4.1.0 | tests the real adapters' command mapping without AWS |

## Not verifiable here

Nothing in this WP touched AWS. Still to confirm at deploy (WP0.10): that `RunMicrovm` returns `RUNNING` only after the `/run` hook has completed (if it does not, rotate v0 should additionally probe `/health` on port 8081 before writing the pointer), and the exact string format of `endpoint` (the adapter normalizes away a scheme and trailing slash either way).

## Drift

None in the design. Two details it left implicit are now fixed by the code: the pointer's initial state after a fresh deploy is `off` until `mise run up`, and the fleet secret lives in Secrets Manager rather than an environment variable.

One tooling correction in the root `bunfig.toml`: Bun's coverage threshold key is `line`, not `lines`. With the wrong key Bun applied its default threshold and `bun test` exited 1 despite 99 % line coverage; this WP was the first with enough files to trip it.

## Open

- WP3.2 replaces the `noop-running` branch with the hourly handover protocol.
