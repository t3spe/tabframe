# Tabframe

A fault-tolerant distributed computer whose cores are browser tabs and Firecracker microVMs.
Open the page and you are a core. Close it and the machine keeps computing, correctly.

Programs are WebAssembly modules with two entry points: `plan`, which lays out stages of work,
and `run`, which executes one task. Both run on the cores. A small control plane holds only
metadata and hashes; result bytes live in a content-addressed store. Tasks are idempotent and
results are memoized by hash, so a dead core is a non-event and program code has no error path.

The demo workloads, a distributed Mandelbrot render and a MapReduce word count, are real programs
that go through the same path as anything you write in the in-page editor.

## Status

Design complete, build starting. The design record and the milestone plan will land under `docs/`.

## Layout

A Bun workspace, tooling managed by [mise](https://mise.jdx.dev). Details in `docs/` as they arrive.
