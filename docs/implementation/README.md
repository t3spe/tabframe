# Implementation log

One document per work package, written on the WP's branch and merged with it. Each covers what was
delivered, how it works, why it is built that way, the evidence, any design drift, and open items.
Screenshots and other evidence live under `assets/wp-<m>.<n>/`.

| WP | Document | Merged | Summary |
|---|---|---|---|
| WP0.1 | [wp-0.1-repo-scaffold.md](wp-0.1-repo-scaffold.md) | 2026-09-01 | Workspace, tooling, guard task, docs, license |
| WP0.2 | [wp-0.2-protocol.md](wp-0.2-protocol.md) | 2026-09-01 | Envelope, M0 messages, close codes, limits, canonical codec |
| WP0.3 | [wp-0.3-core.md](wp-0.3-core.md) | 2026-09-01 | Ledger, apply(event) → effects, liveness sweep, refusals, interfaces |
| WP0.4 | [wp-0.4-control-plane.md](wp-0.4-control-plane.md) | 2026-09-01 | Process: two listeners, sockets → core, hooks, local store, session emulation |
| WP0.12 | [wp-0.12-ci.md](wp-0.12-ci.md) | 2026-09-01 | GitHub Actions: lint, unit, browser tests on every push; nightly simulation; no AWS in CI |
