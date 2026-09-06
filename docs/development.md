# Developing

How to run the machine on a laptop, what the tasks are, and what the tests prove. The design
record's [§11](design.md#11-tooling-and-repo) and [§12](design.md#12-tests-and-dev-loop) say why the
toolchain and the test layers are shaped this way; this page says how to use them.

## Toolchain

Tooling is managed by [mise](https://mise.jdx.dev), every tool at an exact version, so a second
machine builds the same image. Node.js 22 is the runtime everywhere in production and runs `.ts`
files directly, so the control plane needs no build step locally. Bun is the developer toolchain
(workspaces, `bun test`, the browser bundles), and nothing at runtime depends on it. AssemblyScript
is a workspace dependency rather than a mise tool, so the build-time and in-browser compilers are
the same pinned version.

```sh
mise trust && mise install      # tools: node, bun, aws-cli, gh, cdk
mise run install                # workspace dependencies and the Playwright browser
```

Nothing on this page needs an AWS identity. The tasks that talk to AWS are the runbook's, and every
one of them depends on `whoami`, which asserts the account.

## The machine on a laptop

```sh
mise run dev                    # → http://127.0.0.1:4080
mise run dev:rotate             # a second control plane and a real handover, on the laptop
```

`mise run dev` starts the control plane under `node --watch` in local mode: an in-memory ledger, a
local store route with a hash-verifying PUT, self-presign, an emulated session endpoint, and the
lifecycle hooks as routes. It also starts two local cores as Node processes on the node platform
entry, the web bundles in Bun watch mode, and the seeding of the shipped programs. The public and
private ports are 4080 and 4081 locally; the image uses 8080 and 8081. It is the same code as the
cloud: the control plane serves blobs from memory, the two Node processes stand in for the cloud
cores, and the page is served from `packages/web/dist`. `mise run dev:rotate` drives the real rotate
code with a local driver, so a handover is exercised before it touches AWS.

## Tasks

| Task | What it does |
|---|---|
| `mise run build` | everything: the programs, the page, the control-plane bundle and the staged image directory |
| `mise run build:programs`, `build:web`, `build:image` | one of the three (`build:web -- --watch` for the dev loop) |
| `mise run test` | unit and integration tests, then the browser tests |
| `bun test` | the unit and integration suites alone |
| `bunx playwright test` | the browser suites alone, with the programs and the page built first |
| `mise run lint` | Biome lint and format check, then a TypeScript type check |
| `mise run sim -- --seed 7` | the churn simulation (`--long` for the long scenario, `--drill` for the fleet) |
| `mise run goldens` | regenerate the program goldens from single-node runs |
| `mise run corpus` | fetch and normalize the word-count corpus |
| `mise run synth` | synthesise the CDK stacks without credentials |
| `mise run ci` | what CI runs: build everything, synthesise, lint, unit tests, browser tests |

Every task is defined in [`mise.toml`](../mise.toml); `mise tasks` lists them with their descriptions.

## Tests

What each layer proves, and which runner runs it, is the table in the design record's
[§12](design.md#12-tests-and-dev-loop): the protocol's schemas, the pure core, the churn simulation,
the sandbox, the programs against their goldens, the control-plane process over real sockets, the
fleet against a fake MicroVM client, the browser end to end, and the stacks' synthesis. Two things
to know when running them:

- **Coverage.** `bun test` runs with coverage on; `bunfig.toml` sets an 85 % line threshold for
  protocol, core, sandbox, control-plane, and fleet, and reports only for web.
- **Goldens.** The tests and the simulation compare against recorded outputs of single-node runs.
  `mise run goldens` regenerates them, and any change to a program kernel updates them in the same
  commit.

Two repository-wide checks run with the unit suite, from `tests/`: every relative Markdown link and
anchor resolves, and no source comment carries a work-package tag, a date, or narration of what the
code used to do; comments say why.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every push: a fresh checkout, the
same mise version as the developer machine, then `mise run ci` (build everything, synthesise the
stacks, lint, the unit suites, the browser suites), and it keeps the coverage report as an artifact.
It first asserts that no AWS credentials, profile, or `.env.local` are present: CI never touches the
account, and deploys are manual ([`runbook.md`](runbook.md)). A red `main` is the first thing fixed,
and no work package starts on a red `main`: CI runs on a fresh checkout with nothing built and
catches what a laptop with built artifacts does not.

## Conventions

- One branch per work package, merged into `main` with a `--no-ff` merge once lint and tests are
  green; no direct commits to `main`; history never rewritten. Each work package lands a note under
  [`implementation/`](implementation/README.md).
- Biome formats and lints. The base tsconfig sets `erasableSyntaxOnly`, because Node strips only
  erasable TypeScript syntax: no enums, namespaces, or parameter properties.
- The design record is the source of truth; when a change departs from it, the record's drift log
  at the end says what changed and why.
