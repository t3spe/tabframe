# WP7.2 — The throughput chart and the small rows

**Branch** `wp/7.2-throughput-rows` · **Milestone** M7 · **Date** 2026-09-03 · **Ask** Mircea's
third review, item 2 ("wonky horizontal blue lines", the throughput chart beside "48.8 tiles/s · 3
nodes") and item 11 (the counters row clipped its last cell, the redundancy toggle's label wrapped
into three lines beside the buttons, the row of bordered flash boxes was cut off at the right).
Decision D2 (recommended): a crisp sparkline on a slow scale, not the figure alone.

## What was wrong

The chart drew sixty one-second buckets as three-pixel bars on a 240×36 canvas that was never
scaled to the screen's pixel density (blurry on any modern display), rescaled every frame to the
minute's peak (the whole strip jumped whenever the peak moved), highlighted the newest bar, and at
demo speed the buckets were noise. It had no caption, no axis, nothing that said what it was.

## What changed

- **One quiet line.** `renderChart` draws the last fifty-nine full seconds as one area line
  (the current second is still filling and would always dip), at `devicePixelRatio`, over a faint
  baseline, with a caption inside the canvas: "last 60 s · peak 61 tiles/s · scale 100". The
  figure beside it is unchanged ("48.8 tiles/s · 3 nodes"). The execution row's second line grew
  from 1.6 to 2.5 rem so the 36-pixel canvas is not clipped (the first draft was).
- **A slow scale.** The y scale is a round number (1, 2, 5 × 10ⁿ, `niceCeil`) that rises at once
  when the peak passes it and comes down only after a minute below half of it; the canvas carries
  it as `data-scale` and its tooltip says the scale moves at most once a minute.
- **Counters in two rows.** Eight cells in a four-column grid of fixed height; nothing is clipped
  at common widths.
- **The redundancy toggle on its own line** under the cluster controls, with a tooltip that says
  what it does (every task computed twice on different nodes; the bytes must agree).
- **The flashes as one line of text** under the legend ("just now · 17:58:54 t3092 verified by n1
  · t3446 taken back from n3 · …"), coloured by kind, cut with an ellipsis; the activity tab keeps
  every flash. The bordered boxes are gone.

## Tests

- `e2e/polish.e2e.ts`: the canvas's pixel box equals its CSS box times the device pixel ratio;
  over five seconds of a steady demo frame the scale takes at most two values; the tooltip says so;
  eight counters, each inside the counters box; the toggle's label and the flash line are each one
  line high. The layout probes of the demo suite keep passing (the boxes changed size once, at
  build time, not at run time).

## Drift

`docs/design.md` §17 entry of 2026-09-03 (WP7.2).
