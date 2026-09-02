# M2 verification

`mise run verify:m2` against the deployed machine in the Tabframe account (us-west-2), generation
16, on 2026-09-02. It is a reviewer's path, driven by a real browser: lend the machine some CPU,
edit the Mandelbrot source in the page, compile it there, launch it and watch the cluster run it;
launch word count over Moby-Dick from the programs panel and check the top-K; then make a program
fault and watch the execution fail and the machine carry on.

| Check | Result | Pass |
|---|---|---|
| Session | generation 16 | yes |
| Tabs lending CPU | 2 tabs, 4 nodes | yes |
| Compiled in the browser | compiler ready in 4.1 s, **compiled in 3.4 s**, source edited | yes |
| An edited program runs on AWS from the page | e112 finished; 1131 distinct tiles, **different from the unedited goldens** | yes |
| Word count over Moby-Dick | e115 finished; top three `the 14529, of 6620, and 6446`; **the top-25 equals the goldens, hash for hash** | yes |
| A program fault fails its execution visibly | `task t68780 failed: abort: verify-m2: this planner refuses to plan` | yes |
| The machine moves on | no nodes lost; eight executions started over the run | yes |

Seven checks, none failed, in 83 seconds.

## What it means for the design

- **The machine is general-purpose, and the page is the compiler.** The AssemblyScript compiler
  runs in a browser worker, compiles the edited Mandelbrot in about three seconds, and the module
  it produces is uploaded and launched over the same observer socket the dashboard uses. Nothing
  about the program was known to the control plane in advance: it fetched the bundle, validated the
  module's imports, exports, size and declared memory, and only then minted an execution.
- **The edit shows.** The runbook halves the palette cycle, and the tiles the cluster produced are
  not the goldens — the picture changed because the program changed, which is the point of an
  editor that compiles for real rather than one that re-runs a fixed binary.
- **Word count is exact.** Three stages — 32 map tasks over byte ranges, 8 reduce tasks by
  partition, one merge — and the final `bars` payload matches the golden **hash**, so all 25 words
  and counts agree with a single-process reference. The answer was read the way a person would:
  the execution's final filesystem root, fetched by hash, then `/out/2/0`.
- **A fault is a fact, not a crash.** The trapping planner's own abort message reaches the
  dashboard, the execution fails, and the machine goes back to its loop with every node intact.

## Notes

- **Seeding had to become idempotent.** A control plane that adopts its predecessor's ledger used
  to skip seeding entirely, so a program added in a later deploy (word count) never appeared on a
  machine that keeps rotating. Seeding now compares bundle hashes and adds what is missing, which
  is also what makes a deploy-as-rotation deliver new programs.
- **Leaked headless browsers broke three runs before this one.** A killed runbook left Chromium
  processes lending nodes; those sockets count against the MicroVM endpoint's concurrency budget
  (`docs/m3-verification.md`), so the next run's pages could not connect at all and reported "the
  page was not live". The runbook now closes its browser on a signal, on an uncaught exception, and
  on an unhandled rejection. If a run ever fails oddly, check for stray `headless_shell` processes
  first.
- The machine rotates hourly on its own now, so a tab that opens mid-rotation waits for the new
  control plane; the runbook reloads once rather than failing.
