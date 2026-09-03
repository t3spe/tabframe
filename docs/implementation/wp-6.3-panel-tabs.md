# WP6.3 — Big panels open in their own tab

**Branch** `wp/6.3-panel-tabs` · **Milestone** M6 · **Date** 2026-09-03 · **Ask** "panels that are
dynamic with a lot of info produced (e.g. the ledger) should show a link and open in a new observer
tab when clicked; it does not help to show a lot of scrolling things without understanding what it is"

## What changed

- The ledger, files, and activity sections of the dashboard now show a **one-line summary** and an
  **open ↗** link; their tables and lists are hidden there. The summaries are sentences with the
  numbers that matter: "312 settled tasks · 4.9 MB in the store · hashes, not bytes"; "root
  3f9a… · 646 files · 11.2 MB · every byte fetched from the store by hash"; "212 lines · last:
  12:04:31 t318 taken back from n7".
- The link opens `/?observe&panel=ledger` (or `files`, `activity`) in a new tab: an observer-only
  page (it lends no node) that renders that one section full-width under an **explanation** of what
  the reader is looking at and how to read it, then the whole thing — every settled task in the
  ledger (the dashboard kept the newest eight), the whole activity log (the dashboard kept the last
  fourteen lines), the full file list with its previews. The tab's title names the panel. Because
  the files tab cannot see the stage strip, it offers the stages' roots itself ("roots: stage 0
  stage 1 …") for browsing an earlier filesystem, with "follow the execution" to come back.
- Each such tab is one observer connection of the endpoint's sixteen; the summary line on the
  dashboard is fixed-height, which WP6.2 builds on.

## Tests

- `e2e/panels.e2e.ts`: the word-count demo browses files on the files tab (previews, an earlier
  root, follow); a new test checks the dashboard's summaries and links, the ledger tab (explanation,
  300 rows at the demo's pause, nothing else on the page, the title) and the activity tab (the whole
  log). The polish suite's ledger assertions hold on the hidden table.
- The demo's ledger-and-files beat opens both tabs from the links and reads them there.

## Drift

- Design §8.3 / §6.7: the dashboard's three big panels summarise; their own tabs carry the detail
  and an explanation. `?panel=` query flag on the dashboard page.
