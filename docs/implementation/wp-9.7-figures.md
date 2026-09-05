# WP9.7 — The figures as SVG

**Status:** done 2026-09-05.

## What

The two figures the documents carried as ASCII art — the README's architecture picture and the
design record's runtime picture (§3) — are SVG files under `docs/diagrams/`, embedded as images.
Each carries a title and a description for readers without the picture, and the Markdown alt text
says the same in one sentence.

## Why

Box-drawing characters render as intended only in a monospaced block whose font has every glyph,
and they wrap or misalign anywhere else: GitHub's mobile view, a narrow editor pane, a PDF export.
A figure a reader cannot read is worse than none. SVG scales, keeps the text selectable and
searchable, and states its palette and type once.

## How

One generator holds both figures as specs — boxes, zones, arrows, labels — and writes the files, so
the two share one palette (paper, ink, a hue per kind of thing: browser, cloud compute, store,
fleet), one type scale, and one arrow. It lives with the working notes outside this repository;
the SVG files are the artefacts here and are plain enough to edit by hand. The link test already
checks that every image a document embeds exists.

## Verified

- `bun test tests/` — every relative link and image resolves.
- Each file parses as XML and renders in Chromium with no overlapping labels.
