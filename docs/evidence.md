# What is measured

Each claim below was checked against the deployed machine, not a laptop; the tables behind the
numbers are in the implementation notes linked from the rows. The unit and integration suites (an
85 % line-coverage threshold on the core packages) and the browser suites run in CI on every push,
with no AWS credentials.

| Claim | Evidence |
|---|---|
| Kill half the cluster mid-frame and the frame still completes, bit for bit | 6 nodes from tabs, 3 killed at tile 128: **640 of 640 tiles match the goldens** produced by a single Node process on another machine ([`wp-1.10-deploy-m1.md`](implementation/wp-1.10-deploy-m1.md)). The browser suite repeats it with ten nodes in one tab. |
| A program edited and compiled in the page runs on the cluster | compiled in the browser in ~3 s, byte-identical to the build's module; the edited frame's tiles differ from the unedited goldens ([`wp-2.7-deploy-m2.md`](implementation/wp-2.7-deploy-m2.md)) |
| Word count is exact | the top-25 over *Moby-Dick* equals the JavaScript reference **hash for hash** |
| A program fault is visible, not fatal | a planner that traps fails its execution with its own abort message and the machine returns to its loop |
| The control plane rotates with a render in flight | **8.4 s of churn** from the drain to the first tile of the new generation, four rotations, 8.4–8.5 s each; the session function peaked at 3 concurrent executions with no throttles ([`wp-3.5-deploy-m3.md`](implementation/wp-3.5-deploy-m3.md)) |
| Correct under arbitrary churn | a discrete-event simulation with virtual nodes running the real WebAssembly programs, seeded chaos (joins, leaves, crashes, freezes, hidden tabs, every control, a lying node, the fleet), invariants after every event, goldens at the end: **1000 long seeds pass** ([`wp-1.9-churn-sim.md`](implementation/wp-1.9-churn-sim.md)) |

## Re-running the checks

| Check | Command | Needs |
|---|---|---|
| A frame through a kill-half on the deployed machine: golden hashes, uploads, snapshots | `mise run verify:m1` | the `tabframe` profile |
| Edit and compile a program in the deployed page, run word count, make a program fault | `mise run verify:m2` | the `tabframe` profile |
| A rotation under load: churn seconds, drain jitter, session-function concurrency | `mise run verify:m3` | the `tabframe` profile |
| The churn simulation, one seed | `mise run sim -- --seed 7` (`--long` for the long scenario, `--drill` for the fleet) | nothing |
| The browser suites: spawn ten, kill half, canvas hash equals golden; editor compile and launch; a local rotation mid-render | `bunx playwright test`, with the programs and the page built first (`mise run build`) | nothing |
| The unattended demo against the deployed machine, about five minutes | `mise run demo` (`-- --repeat 3` for three passes) | the `tabframe` profile |

Each verification task prints one line per check and exits non-zero on a failure; the runbook says
which to run after which kind of change ([`runbook.md`](runbook.md)). What each layer of the test
suite proves, and which runner runs it, is the table in the design record's
[§12](design.md#12-tests-and-dev-loop).
