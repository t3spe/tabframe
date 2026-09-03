# WP6.6 — An editor that explains itself

**Branch** `wp/6.6-editor-guide` · **Milestone** M6 · **Date** 2026-09-03 · **Ask** "it's not clear
what the code in the editor is, and it should maybe provide a guide to what operations it supports"

## What changed

- **A guide under the source**: the SDK's README, rendered in the editor tab from Markdown at
  page load — what a program is (one WebAssembly module, `plan` and `run`, a manifest), the two
  calls and what they get and return, the SDK's helpers (`Params`, `Stage`, `fs`, `log`,
  `ByteWriter`/`ByteReader`, `bars()`), how a multi-stage program reads the previous stage's
  results as files, and how to compile outside the page. It is embedded by the same generator that
  ships the program sources, and the editor-core test fails if the committed copy differs from the
  README on disk, so the guide and the SDK cannot drift apart. A line above it states the numbers
  this machine holds a program to: the memory maximum (256 pages, 16 MB), the module size, inline
  input, output, writes, log, the deadline, and the three views.
- **Three examples to load** from a select in the editor's head: Mandelbrot (tiles, one stage, a
  follow-up), **hello** (the smallest program: one task, a line of text in the text view — new,
  `packages/sdk-as/examples/hello.ts`, with a header that says what `plan` and `run` are), and
  word count (three stages over a file). Loading one fills the source and the manifest form (name,
  view, description, params) and shows a one-line note: what it does and what a launch from the
  editor needs — word count is there to read, since the editor ships no inputs and the shipped
  bundle carries the corpus. Reset returns to the selected example.
- Every shipped program opens with a header comment saying what it does (Mandelbrot and word count
  already did; hello's is the tutorial).

## Tests

- `packages/web/src/editor-core.test.ts`: three examples with parsed manifests, distinct sources,
  and notes; the guide is the README (its headings and `fs.read`); the generated module is fresh.
- `e2e/editor.e2e.ts`: the guide renders with its headings, code blocks, and the limits line; hello
  loads, fills the form, compiles in the page; word count's note says "no inputs"; reset returns to
  the selected example.
- `hello.ts` compiles with the SDK's own flags (checked by hand with `asc`; the editor test compiles
  it in the browser).

## Drift

- Design §5.6: the editor carries the guide and three examples; the hello example lives with the
  SDK. `program-sources.generated.ts` also carries word count, hello, and the README.
