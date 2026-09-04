# WP7.5 — The editor's layout and the guide page

**Branch** `wp/7.5-editor-layout-guide` · **Milestone** M7 · **Date** 2026-09-04 · **Ask** Mircea's
third review, items 7 and 8: "the editor makes wacky use of space" and "'what is a program' should
be a link at the top providing help, not awkwardly showing at the bottom". Decision D4
(recommended): the guide is a page of its own in a new tab, linked from the top of the editor.

## What was wrong

The source box was twenty lines tall in a page whose bottom two thirds were the guide (WP6.6 put
it under the source so it would be found) and empty space; the launch column sat beside a short
source and nothing filled the height.

## What changed

- **The editor uses the whole viewport.** The page is a column: a one-line head (title, machine
  pill, the pause sentence, "What is a program? ↗"), a two-line introduction, then a grid that takes
  the rest of the height — the source on the left, filling it, with one action bar (compile, launch,
  reset source, the compiler's note) and a scrolling diagnostics list under it; the launch column
  (program select, name, view, description, params, the drop door, module and launch info) on the
  right, scrolling if it must. Nothing scrolls sideways; under 1100 px the columns stack.
- **The guide is `/guide.html`.** The same rendered README and the limits sentence
  (`limitsSentence()` in `editor-core.ts`, shared), with a two-line preamble and links back to the
  editor and the dashboard. `guide-page.ts` is a fourth page entry of the web build. The editor's
  head links to it as "What is a program? ↗" and the editor page no longer carries the guide.

## Tests

- `e2e/editor.e2e.ts`: the editor shows the introduction and the guide link, and carries no guide;
  the guide page renders the README's headings and code, the limits with "256 pages", and the link
  back. At 1280×800 and 1440×900 the source pane takes at least 45 % of the viewport height, ends
  inside it, and the page scrolls neither sideways nor down. The compile, launch, drop, and reset
  tests pass unchanged.

## Drift

`docs/design.md` §5.6 / §17 entry of 2026-09-04 (WP7.5).
