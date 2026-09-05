# Browser tests

Playwright suites, `*.e2e.ts`, one per screen or concern; `playwright.config.ts` starts one local
control plane with the built page and runs the suites serially against it, so a suite may assume it
is alone with the machine. `bunx playwright test` runs them locally after `mise run build:programs`
and `mise run build:web`; `TABFRAME_URL=https://…` runs the same suites against a deployed machine,
which is what `mise run demo` does with `demo.e2e.ts`. `docs/walkthrough.md` is the contract
`walkthrough.e2e.ts` checks.
