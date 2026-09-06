# WP9.8 — The README as a front door

**Status:** done 2026-09-05.

## What

The root README says what Tabframe is and points at a page for everything else. It went from eleven
sections doing four jobs — front door, page tour, evidence report, operator and developer manual —
to eight sections doing one. Two pages were written to hold what had no home, and two existing pages
gained the sections that had been living in the README.

| README section before | Where its text went | What the README keeps |
|---|---|---|
| Title and pitch | — | the pitch |
| Deployed link, the five clicks, `?observe` / `?demo` | `docs/walkthrough.md`, a new opening section | the link and one sentence, pointing at the tour |
| What it is: the program model, the three programs | `programs/README.md` and the SDK README already held it | one paragraph with the striking facts, three pointers |
| Why it looks the way it does | design §2 already held the full invariants | kept as "The idea", plus one sentence pointing at the evidence |
| Architecture: the figure and eight bullets | — | kept as it was |
| What is measured: the table and the CI sentence | `docs/evidence.md`, new, with a table of how to re-run each check | one pointer sentence |
| Limits, stated plainly | — | kept as it was |
| Running it locally | `docs/development.md`, new | three commands and a pointer |
| Deploying it: prerequisites, commands, "a deploy is a rotation" | `docs/runbook.md`, a new "Before the first deploy" section; the steps were already there | one sentence and a pointer |
| Reading the repository | `docs/README.md` | the Documents list |
| License and attribution | `programs/wordcount/README.md`, a new "Attribution" section | the license and a pointer |

## Why

A README is read first and read fast; a reader who wants the numbers, the commands, or the
prerequisites is a different reader on a different visit, and each of those now has one page. Every
fact has one home; everywhere else is a pointer, so the pages cannot drift apart.

## How

Text was moved, not rewritten: the evidence table, the five clicks, the prerequisites, and the
attribution are the README's sentences in their new place. The one addition is the task table in
`docs/development.md`, taken from the descriptions in `mise.toml`. The architecture and limits
sections were kept as they were, on request. `docs/README.md` is the index in the new reading order:
understand, see, run, write a program, judge, operate, history.

## Verified

- `bun test tests/` — every relative link and anchor resolves, the new pages included.
- The README went from 181 lines to 139, the architecture and limits sections kept whole.
