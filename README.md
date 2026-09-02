# Tabframe

A fault-tolerant distributed computer whose cores are browser tabs and Firecracker microVMs.
Open the page and you are a core. Close it and the machine keeps computing, correctly.

Programs are WebAssembly modules with two entry points: `plan`, which lays out stages of work,
and `run`, which executes one task. Both run on the cores. A small control plane holds only
metadata and hashes; result bytes live in a content-addressed store. Tasks are idempotent and
results are memoized by hash, so a dead core is a non-event and program code has no error path.
The control plane itself is churn: it runs in a Lambda MicroVM that is rotated every hour, and
the ledger outlives it.

The demo workloads, a distributed Mandelbrot render and a MapReduce word count, are real programs
that go through the same path as anything you write in the in-page editor.

## Documents

- [`docs/design.md`](docs/design.md) — the design record, the source of truth for the build.
- [`docs/plan.md`](docs/plan.md) — the execution plan: milestones, work packages, acceptance lines.
- [`docs/implementation/`](docs/implementation/README.md) — one document per work package: what, how, why, evidence.
- [`docs/timelog.md`](docs/timelog.md) — time spent, developer time and total time.

## Status

M0 in progress. See the "Where we are" line at the top of the plan.

## Working on it

Tooling is managed by [mise](https://mise.jdx.dev); the runtime is Node 22, the developer toolchain is Bun.

```sh
mise trust && mise install   # tools
mise run install             # workspace dependencies and the Playwright browser
mise run test                # lint, type check, unit and browser tests
mise run dev                 # local topology: control plane, store, two local cores, web
```

AWS work uses the dedicated `tabframe` profile only; `mise run whoami` guards every AWS task.

## License

AGPL-3.0-only. See [`LICENSE`](LICENSE).
