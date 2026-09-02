# WP0.1 — Repo scaffold

**Milestone:** M0 · **Branch:** `wp/0.1-repo-scaffold` · **Merged:** 2026-09-01

## What

The workspace exists and every tool the build needs installs through mise. Concretely:

- `mise.toml` with the pinned tools (Node 22, Bun 1.3, aws-cli, gh, aws-cdk through the npm backend), the environment (`AWS_PROFILE=tabframe`, `AWS_REGION=us-west-2`, `.env.local` loaded), and every task the plan names, including the ones whose scripts arrive in later WPs.
- A Bun workspace (`packages/*`, `programs/*`) with `tsconfig.base.json` (`erasableSyntaxOnly`, `verbatimModuleSyntax`, strict), Biome for lint and format, and `bunfig.toml` with coverage on and an 85 % line threshold that ignores `web`, `dist`, and the simulation harness.
- `packages/infra` with the `whoami` guard and its masking helper. `mise run whoami` refuses to run unless the profile is `tabframe`, the region is us-west-2, and the caller's account matches `TABFRAME_ACCOUNT_ID` from `.env.local`. It never prints an unmasked account id.
- `LICENSE` (AGPL-3.0), `.gitignore` (including `.env.local`, `cdk.context.json`, build output), the README pointing at the docs, `docs/design.md`, `docs/plan.md`, `docs/timelog.md`, and this implementation log.

## How

- Node runs the TypeScript sources directly (Node 22.23 strips erasable syntax), so operator scripts are `.ts` files run with `node`. Imports use explicit `.ts` extensions; `allowImportingTsExtensions` and `noEmit` make the type checker agree.
- Tests run under `bun test`; `@types/bun` and `@types/node` coexist in the base tsconfig so test files type-check with `tsc` too.
- `mise run test` is `lint` (Biome check, then `tsc --noEmit`) followed by `bun test` and `playwright test --pass-with-no-tests`, so the task is valid before any browser test exists. `playwright.config.ts` confines browser tests to `e2e/*.e2e.ts`; without it Playwright, running under Node, picked up the `bun:test` unit files and failed on the `bun:` import scheme.
- `.env.local` holds the two values that must never be committed: the expected account id and the budget notification address. mise loads it into the environment for every task.

## Why

- **mise for everything** (design §11.2): one file declares tools, environment, and tasks, so a fresh machine reproduces the toolchain with `mise trust && mise install`.
- **Node in production, Bun for development** (design §11.1): nothing at runtime depends on Bun; the guard script is the first proof that `node file.ts` is the operating model.
- **The guard task first** (design §10.1, decision D16): no AWS-touching task exists yet, but every later one declares a dependency on `whoami`, so the safety rail is in place before the first deploy.
- **Exact dependency pins**: every dependency is pinned to the version that was installed, so the lockfile and `package.json` agree and upgrades are deliberate.

## Evidence

- `mise install` → "all tools are installed"; inside the repo: node v22.23.2, bun 1.3.13, aws-cli 2.36.37, gh 2.97.0, cdk 2.1139.0.
- `bun test` → 3 pass, 0 fail; coverage 100 % lines on `packages/infra/scripts/mask.ts`.
- `mise run lint` → Biome clean, `tsc --noEmit` clean.
- `mise run whoami` → `whoami ok: account ********6595, arn:aws:iam::********6595:user/tab, region us-west-2`.
- `mise run test` → lint, unit tests, and Playwright (no tests yet) all pass.

## Dependencies introduced

| Package | Version | Why |
|---|---|---|
| `@biomejs/biome` | 2.5.11 | lint and format, one tool |
| `typescript` | 7.0.2 | type checking only; Node runs the sources |
| `@types/node`, `@types/bun` | 22.20.1, 1.4.0 | types for the two runtimes |
| `@playwright/test` | 1.62.1 | browser tests from WP2.6; installed now so `mise run install` and `mise run test` are valid |
| `@aws-sdk/client-sts` | 3.1124.0 | the guard's identity check |

## Drift

- Local development ports default to 4080/4081 because 8080 is in use on the development machine (recorded in design §12 during preflight; nothing in this WP depends on it yet).

## Open

- The developer-time column of the time log is Mircea's to fill.
