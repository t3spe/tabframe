# WP2.6 — Playwright v1

**Milestone:** M2 · **Branch:** `wp/2.6-playwright-v1` · **Files:** `e2e/`

## What

Two browser suites that test the machine rather than the page.

- **`e2e/money-shot.e2e.ts`** — the demo, run headless. Ten nodes in one tab, the Mandelbrot module
  dropped into the editor and launched with the golden parameters, and once the frame is well under
  way, **kill half**. The frame completes anyway, and the multiset of tile hashes the machine
  reported equals the goldens the SDK suite pins — 640 tiles, computed in browser workers, uploaded
  to the store, named to the control plane only by hash. The test also checks what the page did
  with them: the tile panel says it painted them and **refused none**, which means the page fetched
  every blob and re-hashed it before trusting it, and the canvas is not blank. About twenty
  seconds.
- **`e2e/sandbox.e2e.ts`** — the paths a healthy frame never takes, in a real browser:
  - a program whose `run` never returns: the sandbox worker is killed at the deadline, the control
    plane offers the task to somebody else (a speculative twin or a reassignment), the instant task
    of the same stage still completes, and **every node is still there** — a deadline kill
    terminates a worker, not a tab;
  - a planner that traps: the execution fails carrying the program's own abort message, and the
    machine moves on with its nodes intact.

  Both programs are written in the test, compiled by the in-page AssemblyScript compiler, and
  launched through the editor — so the compile → bundle → upload → launch path is exercised on the
  way to the thing being tested.

The suites share one control plane (Playwright's web server), so each test leaves the machine as it
found it: the sandbox tests kill their executions, and the money shot names its program
`mandelbrot-money-shot` so the panels suite's launch button stays unambiguous.

## What it took

- The web server starts the control plane with **seeding disabled**, so the money shot cannot rely
  on the default loop; launching the frame through the editor is both the fix and a better test.
- The editor's compiler loads lazily and its drop door is live only once it reports ready. Dropping
  a module before that silently does nothing — which passed alone (a warm cache) and failed in a
  full run. The test waits for `ready in`.
- The deadline kill is not visible as "taken back" in the activity list when a twin is already
  running: the control plane speculates rather than reassigning, which is exactly right. The test
  reads the machine's own event stream through a second observer socket rather than guessing at
  the dashboard's wording.

## Evidence

15 browser tests pass in about two minutes: 2 host, 3 dashboard, 4 editor, 3 panels, 1 money shot,
2 sandbox. Lint and the three type-check projects green.

## Left for later

- The money shot uses one tab with ten nodes rather than ten tabs; the two-tab case is covered by
  `host.e2e.ts`, and ten browser contexts would cost minutes for no extra coverage.
- Running the browser suites against the deployed machine (`TABFRAME_URL`) is supported by the
  config but not part of CI; the M1 and M3 runbooks cover AWS.
