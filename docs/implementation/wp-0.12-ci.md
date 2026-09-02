# WP0.12 — CI

**Milestone:** M0 · **Branch:** `wp/0.12-ci` · **Merged:** 2026-09-01

## What

A GitHub Actions workflow, `.github/workflows/ci.yml`, with two jobs:

- **test** — on every push to `main` and to `wp/**` branches, on pull requests, and on manual dispatch: assert no AWS credentials or local secrets, install the toolchain through mise, `bun install --frozen-lockfile`, restore or fill the Playwright browser cache, install Chromium, `mise run lint`, `bun test` (which enforces the 85 % line-coverage threshold from `bunfig.toml`), `bunx playwright test --pass-with-no-tests`, upload `coverage/` always and `playwright-report/` on failure.
- **nightly-sim** — on a nightly cron (03:17 UTC) and on manual dispatch: install the toolchain and run `mise run sim -- --long`. Until the simulation harness exists (WP1.9), the step prints a notice and exits 0 instead of failing.

Plus `bunfig.toml` now writes an `lcov` report to `coverage/` alongside the text table, so the coverage artifact has content.

## How

- **mise in CI.** `jdx/mise-action@v4.3.0` installs mise pinned to `2026.4.11`, the same version as the developer machine, runs `mise install` from `mise.toml`, and caches the tool directory. The project's own task definitions then run unchanged, so CI executes exactly the commands a developer runs.
- **`.env.local` is absent in CI, and that is fine.** `mise.toml` loads it with `_.file = ".env.local"`. Tested in a clean directory with no parent config: mise 2026.4.11 treats a missing `_.file` as empty, exits 0, prints no warning, and every other `[env]` entry still applies. So the workflow does not create a placeholder file; instead its first step asserts the file does *not* exist, that no `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, or `AWS_PROFILE` is present in the environment, and that no workflow file references `secrets.AWS*`. CI has no AWS identity by construction, and the workflow proves it on every run.
- **Playwright cache.** The browser directory `~/.cache/ms-playwright` is cached under a key made of the runner OS and the `@playwright/test` version read from `package.json`, so a version bump invalidates the cache and nothing else does. `bunx playwright install chromium` is idempotent and fast on a cache hit. The plain install is used, not `--with-deps`; the ubuntu-latest runner ships the libraries the headless shell needs.
- **Pinned actions.** Every action is pinned to a full release tag: `actions/checkout@v7.0.1`, `jdx/mise-action@v4.3.0`, `actions/cache@v6.1.0`, `actions/upload-artifact@v7.0.1`. `permissions` is `contents: read`. Concurrent runs on the same ref cancel the older one.
- **Nightly guard.** `packages/core/sim/run.ts` is checked for before invoking the task; absent means a `::notice::` annotation and success, present means the long simulation runs with a two-hour timeout.

## Why

- **Same commands as the laptop** (design §12): the workflow calls the mise tasks rather than re-describing the build, so CI cannot drift from local practice.
- **No AWS in CI** (design §10.2, plan ground rules): asserted at runtime, not just promised. Deploys stay manual from a machine that holds the `tabframe` profile.
- **Coverage as a gate, not a report** (design §12): `bun test` fails below the threshold, so a red CI is the only signal needed; the lcov artifact exists for reading numbers into WP documents.
- **Nightly simulation** (design §12): the long seed matrix is too slow for every push and belongs on a schedule.

## Evidence

- YAML parsed and structurally checked with two independent parsers: `Bun.YAML` through a small validator (triggers, jobs, `runs-on`, timeouts, every step has `uses` or `run`, every action pinned to a full version, no `secrets.AWS` reference) and PyYAML. Result: `structure ok`; jobs `test` (12 steps) and `nightly-sim` (4 steps).
- mise missing-file behavior measured, not assumed: in a directory with no parent configuration, `mise env` with `_.file = ".env.local"` and no such file exits 0 with no warning and exports the remaining `[env]` entries.
- `bun test` in the worktree: 3 pass, 0 fail, 100 % lines; `coverage/lcov.info` written.
- `mise run lint`: Biome and `tsc` clean.
- **First Actions run, on the push of this branch:** [run 33590128353](https://github.com/t3spe/tabframe/actions/runs/33590128353) — conclusion `success`; the `lint, unit, browser` job passed every step, and `nightly long churn simulation` was skipped as designed for a push event. That confirms `jdx/mise-action` installs the pinned mise, `mise install` succeeds on the runner (including `aws-cli` and `gh` through aqua and `aws-cdk` through the npm backend), the plain Chromium install has its libraries on `ubuntu-latest`, and the project's tasks run unchanged in CI.

## Dependencies introduced

None.

## Drift

- `bunfig.toml` gains `coverageReporter = ["text", "lcov"]` and `coverageDir = "coverage"`. The design's "coverage report per package in the WP document" (§12) now has a machine-readable source.
- Observation worth recording: mise merges configuration from parent directories, so a git worktree created *inside* the repository (under `.claude/worktrees/`) inherits the main checkout's `.env.local`. Harmless for CI, which is a fresh checkout, but parallel workers in such worktrees should not assume they are isolated from the developer's environment.

## Open

- If the first Actions run shows the Chromium install missing system libraries, switch the install step to `bunx playwright install --with-deps chromium`.
- `mise install` in CI installs `aws-cli`, `gh`, and `aws-cdk` that the test job never uses; if the cold run is slow, a CI-only `mise.ci.toml` or `MISE_DISABLE_TOOLS` can trim it.
