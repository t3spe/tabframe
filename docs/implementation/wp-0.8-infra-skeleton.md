# WP0.8 — Infra skeleton (CDK)

**Milestone:** M0 · **Branch:** `wp/0.8-infra-skeleton` (from `wp/0.9-fleet-skeleton`) · **Package:** `packages/infra`

## What

The CDK app that defines everything the fleet needs, in three stacks in dependency order
(design §11.4), plus the image staging directory and the base-image-version resolver. Nothing has
been deployed; this WP is exercised by `cdk synth` and template assertions only.

- **TabframeCore** — four private, SSL-only, S3-encrypted buckets: artifacts, blobs (one-year lifecycle; CORS allowing browser `PUT` with the checksum header), snapshots (one-day lifecycle), web. One CloudFront distribution: default behavior to the web bucket, `blob/*` to the blob bucket, both through origin access control, HTTP/2 and 3, price class 100, and **error caching TTL of zero for 403 and 404** so a request that beats an upload cannot pin a miss. The SSM pointer parameter, initial value `{"state":"off"}`. The fleet secret in Secrets Manager (generated, 48 characters). The **$100/month budget** with actual 50/80/100 % and forecast 100 % notifications to `TABFRAME_BUDGET_EMAIL` — skipped entirely with a synth-time warning when the variable is absent, so tests and CI never see an address.
- **TabframeImage** — the MicroVM image (`AWS::Lambda::MicrovmImage`) built from a CDK asset zip of `packages/infra/image/` (Dockerfile, `main.js`, `programs/`), on the managed `al2023-1` base at the context version (`baseImageVersion`, default `1`), arm64, 1 GB minimum, internet egress, hooks **on port 8081** with all six hooks enabled, CloudWatch logging to `/aws/lambda/microvms/tabframe` (log group created here, one-week retention). Environment holds only image-local values: bucket names, pointer name, core role ARN, image ARN, ports. Three roles trusted by `lambda.amazonaws.com` for `sts:AssumeRole` and `sts:TagSession`: build (read the asset, write logs), control plane (put/get blobs, read/write snapshots, read the pointer, run/get/terminate MicroVMs on this account's images, list, pass the core role, logs), core (logs only).
- **TabframeFleet** — `session` and `rotate` as `NodejsFunction`s (Node 22, arm64, ESM bundles) from `packages/fleet/src/lambda/*.ts`; session has a public function URL with CORS for GET from the page origin and reserved concurrency 5; rotate has reserved concurrency 1, a five-minute timeout, and the environment rotate needs (image ARN, control-plane role, session URL, store base, fleet secret ARN); the hourly EventBridge rule targets rotate and is **created disabled**; least-privilege policies per design §10.1. Outputs: session URL, function names, rule name.
- **`packages/infra/image/`** — the Dockerfile from design §11.3 and a placeholder `main.js` that listens on both ports, answers every hook with 200, records the role from the run payload, and serves `/health`. The image therefore builds and boots before the real control plane exists.
- **`lib/base-image.ts` + `scripts/base-image-version.ts`** — resolves the highest `AVAILABLE` version of `al2023-1` for `cdk deploy -c baseImageVersion=N`.
- Repo-root `cdk.json` so `cdk` runs from the root, as the mise tasks expect; the app entry is `node packages/infra/bin/tabframe.ts`.

## How

- The stacks share explicit names (`lib/names.ts`) and derive ARNs from them where a construct reference would create a cycle: `session` may invoke `rotate` by its fixed name while `rotate` needs `session`'s URL; `rotate`'s policy names the hourly rule while the rule targets `rotate`; and the image ARN is formatted from the image name so `rotate`'s environment does not depend on an image attribute.
- Property names and enumerations come from the installed `aws-cdk-lib` L1 and CloudFormation's validator, which the synth test runs: `CpuConfigurations[].Architecture` is `ARM_64`, and the hook properties are `ENABLED`/`DISABLED` flags rather than paths (the platform fixes the paths at `/aws/lambda-microvms/runtime/v1/<hook>` on the configured port).
- `packages/infra/tsconfig.json` relaxes only `exactOptionalPropertyTypes` for this package, because `aws-cdk-lib`'s own optional properties are not declared with `| undefined` and its types reject each other under that flag. The root `tsconfig.json` excludes `packages/infra`; `mise run lint` type-checks both configs.
- `esbuild` is a root dev dependency: CDK detects Bun from the lockfile and runs `bun run esbuild` from the repo root, which only resolves the binary when it is installed at the root.
- Tests synthesize with `aws:cdk:bundling-stacks: []` so no esbuild runs; the real `cdk synth` was run once by hand and bundles both functions (session ≈ 12 KB).

## Why

- **Three stacks, acyclic** (design §9.3): the image must not know anything about the fleet, so a rebuilt image never depends on a function URL and the fleet can be redeployed without touching the image.
- **Budget skipped without an address**: the address must never be in the repo or a test artifact; making the construct conditional is simpler than any placeholder-scrubbing.
- **Error caching TTL zero** (design §7.1): CloudFront's default five-minute negative cache would turn a benign race into a missing tile for every observer.
- **CORS `*` on the blob bucket**: presigned URLs are the authorization; restricting the origin to the distribution's own domain would make the bucket depend on the distribution that serves it.
- **Hooks on the private port** (decision D18): browser tokens are scoped to 8080, so the lifecycle and fleet endpoints on 8081 are unreachable with a browser token.
- **A placeholder that answers hooks**: an image whose `/ready` never returns 200 never finishes building; shipping a boring but correct process lets WP0.10 deploy the skeleton before the control plane exists.

## Evidence

- `bun test packages/infra` → 19 pass, 0 fail; coverage 100 % lines on every `lib/` file. Assertions cover: bucket count and public-access blocks; lifecycle and CORS on the blob bucket; the distribution's blob behavior and zero error caching; the pointer's initial value; the secret; budget absent without an address (and no `@` anywhere in the template) and present with four notifications with one; the image's base ARN/version, arm64, 1 GB, hooks on 8081 all enabled, an `s3://` code artifact, and an environment free of fleet keys; three roles trusting `lambda.amazonaws.com` with AssumeRole+TagSession; PassRole restricted to the core role; the core role without MicroVM actions; two functions with the design's names, runtime, architecture, and concurrency; the public URL with GET CORS; the rule created disabled; session able to invoke but not run; rotate able to run, write the pointer, and read the secret; stack dependencies exactly Core → Image → Fleet.
- CloudFormation's validator (run inside the synth test) reports no warnings.
- `mise x -- cdk synth --quiet` → all three templates, both functions bundled.
- `mise run lint` → Biome clean, both `tsc` runs clean.

## Dependencies introduced

| Package | Version | Why |
|---|---|---|
| `aws-cdk-lib` | 2.267.0 | the constructs, including `CfnMicrovmImage` |
| `constructs` | 10.8.1 | CDK's construct tree |
| `esbuild` (root, dev) | 0.28.2 | `NodejsFunction` bundling from the repo root |
| `aws-sdk-client-mock` (dev) | 4.1.0 | the base-image resolver's SDK test |

## Not verifiable here

- Whether the `AWS::Lambda::MicrovmImage` resource accepts the exact property shapes at deploy time; the CloudFormation validator is satisfied, the service may add constraints. WP0.10 finds out.
- Whether `RUNNING` implies the run hook completed (see WP0.9).
- CloudFront's behavior with `Range` requests to S3 through OAC (it is supported; the blob behavior uses the default `CachingOptimized` policy).

## Drift

None in the design. Two tooling notes: the infra package needs its own tsconfig (above), and `esbuild` lives at the root.

## Open

- `cdk bootstrap` and the first deploy are the parent's (WP0.10), followed by `mise run verify`.
- The cross-stack reference strength feature flag is pinned to `strong` in `cdk.json` to keep the current CDK default explicit.
