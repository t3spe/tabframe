# WP6.2 — Nothing changes size

**Branch** `wp/6.2-layout-stability` · **Milestone** M6 · **Date** 2026-09-03 · **Ask** "make sure
that the elements in the UI are at the maximum size — it is annoying for things to flicker in and
out as they change size, for example the progress blocks underneath the Mandelbrot representation"

## What changed

Every region of the dashboard that used to appear, disappear, grow, or shrink as the machine runs
now keeps a reserved box, in `styles.css` (a "nothing changes size" block at the end):

- **Hidden means invisible, not gone.** The stage strip, the failure and warnings lines, the
  follow-up row, the pulses, the task detail, the rotation banner, the transient notice, the
  header's rotation pill, the node table, and the toggling controls (Stop/Start, Resume, kill
  execution) keep their box when hidden — `visibility: hidden` with the box's `display` forced past
  the `hidden` attribute.
- **Fixed heights, scrolling inside.** The stage strip is one row of fixed-width stage chips that
  scrolls sideways rather than wrapping; the pulses are one row; the counters are one row of eight
  fixed-width chips that stay in place while nothing runs (dashes for numbers); the task detail,
  the node table, your nodes, the programs, and the queue scroll inside fixed heights; the failure
  and warnings lines are one line with an ellipsis.
- **Text that can grow is cut, not wrapped.** The execution row, the header pills (each with a
  minimum width), the throughput figure, and the tile statistics keep one line with tabular digits.
- **The picture's box is fixed.** The tiles canvas and the bars/text result share one 8:5 box; the
  task grid keeps its height whatever the number of rows.
- **The connection banner overlays the stage** instead of replacing it, so a reconnect does not
  collapse the page and the picture stays where it was.

## Tests

- `e2e/polish.e2e.ts`: in demo mode the boxes of eighteen regions are measured at the page's first
  live frame, after the frame paused at 300 tiles, and after a kill-half control — all equal.
- `e2e/demo.e2e.ts`: the unattended demo measures twenty-one regions at every beat against AWS and
  fails at the end if any changed size across the run.

## Drift

- Design §8.3 (the dashboard): reserved boxes, hidden-is-invisible.
- The stylesheet gained the stability block; `index.html` wraps the tiles canvas and the result view
  in one `.stage-box`.
