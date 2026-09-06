# Programs

A Tabframe program is one WebAssembly module with two entry points, `plan` and `run`, and a
`manifest.json` beside it. `plan` turns the parameters and the previous stage's outputs into the
next stage's tasks; `run` turns one task's input into bytes. Both execute on the cores; the control
plane never runs program code. A program sees the world only through a per-execution filesystem of
content-addressed blobs (no clock, no randomness, no network, no failure type in its API), so the
same bytes come out of a browser tab and a MicroVM, and a task can be re-run anywhere without harm.

Three programs ship with the machine and go through the same path as anything written in the
in-page editor:

| Program | View | What it computes |
|---|---|---|
| [`mandelbrot/`](mandelbrot/README.md) | tiles | one 2048×1280 frame of the Mandelbrot set as 640 tiles, a preset that advances every frame |
| [`wordcount/`](wordcount/README.md) | bars | the exact top-K words of *Moby-Dick* in three stages: map, reduce, merge |
| [`tinygpt/`](tinygpt/README.md) | text | greedy continuations from a 0.8 M-parameter character-level GPT trained on the same corpus |

Each directory holds `assembly/index.ts` (the source, AssemblyScript), `manifest.json` (name, view,
default parameters, description), inputs under `in/` where the program needs any, and `dist/` after
a build. `mise run build:programs` compiles all three; `mise run goldens` regenerates the recorded
outputs the tests and the churn simulation compare against. How to write one, and what a program may
and may not do, is in [`packages/sdk-as/README.md`](../packages/sdk-as/README.md).
