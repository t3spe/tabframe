# WP4.8 — CI green, and a gate

**Branch** `wp/4.8-stale-dist` · **Milestone** M4 · **Date** 2026-09-02

## Why

CI on `main` had been red for 23 runs since the WP1.9 merge and nobody looked: the churn simulation
loads `programs/mandelbrot/dist/program.wasm`, which is not committed and was never built on the
runner. Local runs passed because the module was there.

## What changed

- `packages/core/sim/program.ts` builds a program on demand, and rebuilds it when any program or
  SDK source is newer than the module; `packages/control-plane/src/fixtures.ts` does the same for
  the control-plane fixtures. CI builds the programs explicitly before lint and tests.
- Biome's default diagnostic cap had turned warnings into a failing exit; the `useOptionalChain`
  warnings are fixed.
- Two browser flakes on the slower runner: the panels suite dropped a module before the compiler
  had loaded (`#editor` is visible before the lazy import resolves — wait for "ready in"); the
  money shot read the painted count once and judged the recovery by one activity line (now a poll,
  and the counters).
- The M1 runbook picks the newest `mandelbrot` by `addedAt` and reads the snapshot pointer with
  `HeadObject` instead of a paged listing; the M0 runbook polls after a suspend (the proxy answers
  502 until the MicroVM is back).

## The rule

`docs/plan.md` ground rules and design §11: **CI on `main` must be green before the next work
package starts.** The gate is read from the run's `conclusion` (`gh run view --json conclusion`),
never from a piped exit code — the first two watches in this work package were misread that way.
