# WP7.4 — Files and ledger rows open in the page

**Branch** `wp/7.4-files-ledger-in-page` · **Milestone** M7 · **Date** 2026-09-03 · **Ask** Mircea's
third review, items 5 and 6: the ledger's "where" downloaded a file instead of showing the bytes,
and clicking a file flickered the screen. Decision D3 (recommended): open in the page, in a preview
box that is always there; the new tab and the raw bytes stay as small secondary links.

## What was wrong

The ledger's address column linked to the store's own address for the hash, which CloudFront
serves as a plain byte stream, so the browser saved a file. WP6.8 had made every file name open a
new tab — a full page load that starts black — while the row's click rebuilt the whole files list
and the preview, so the panel flashed too.

## What changed

- **One preview box on each tab, always there.** The files tab's `#filePreview` and the new ledger
  tab's `#ledgerPreview` are fixed boxes with a placeholder that explains what a click will show.
  One renderer (`renderBytesInto`) draws a head — name or task, size, the whole hash, a small
  "raw ↗" link to the store — and the bytes by kind: a bar chart, text, a tile, a manifest, or a
  hex head. Both boxes are hidden on the dashboard, whose files and ledger panels are summaries.
- **A file name shows the file in the page.** The row's click sets `selectedFile`, toggles the
  `selected` class on the rows in place, and redraws the preview; the selection is no longer part of
  the files list's render signature, so the list is not rebuilt by a click. A small "↗" beside the
  size opens the pinned viewer tab (WP6.8's URL), and it is the only thing that opens a tab.
- **A ledger row shows the task's bytes.** Rows are clickable and highlight in place; the tile
  size comes from the task's placement when it has one. The address column is text with a small
  "raw ↗" beside it whose tooltip says the browser will save the file.

## Tests

- `e2e/panels.e2e.ts`: on the files tab the preview box explains itself before a click; clicking a
  file name renders its 25 bars in the page, the row is selected, the row node is the same object
  as before the click (a marker survives), and no tab opened; the arrow opens the pinned viewer tab
  as before. On the ledger tab a row click renders the task's bytes and highlights one row.

## Drift

`docs/design.md` §17 entry of 2026-09-03 (WP7.4).
