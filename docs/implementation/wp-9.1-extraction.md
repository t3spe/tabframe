# WP9.1 — Extraction: the repository stands on its own

**Branch** `wp/9.1-extraction` · **Milestone** M9 · **Date** 2026-09-04 · **Ask** Mircea: everything
about the homework as a piece of work — time tracking, transcripts, the assignment's specifics, the
video, the documents written to accompany the submission — leaves the repository for a local git
repository of its own, so that this one makes sense to anyone who comes across it.

## What moved

To a sibling repository outside this one (git, local only, one commit): `docs/plan.md`, `docs/timelog.md`,
`docs/rationale.md`, `docs/submission-checklist.md`, `docs/m0…m3-verification.md` (as
`verification/m0…m3.md`), `docs/transcripts/` (27 scrubbed exports), the transcript exporter
(`scripts/transcripts/export.ts` and `packages/dev/src/transcripts.ts` with its test, now
`tools/export-transcripts.ts` and `tools/transcripts.ts`, self-contained, eleven tests passing), the
raw JSONL sources and the demo footage that lived beside the repository, the older working notes
(seed, handoff, roadmap), and the assignment. The exporter's two private keys left `.env.local` for
the tracking repository's own `tools/.env`; the `transcripts` task left `mise.toml`.

## What changed here because of it

- The README no longer frames the project as an assignment: no "the rationale the assignment asks
  for", no "reviewer hour"; the reading table lists what remains — the design record, the runbook,
  the walkthrough, the feasibility note, the implementation notes, the SDK guide, the programs.
- The design record's §13 is "Deploy and operations", written for a visitor; §14 is a short
  "History" pointing at `docs/implementation/`; the hours bullet left §15; §9.5's cost table and
  §3's first minute say "visitor"; §11.3 lists the documents that exist. The drift log (§17) is
  untouched, dangling names in its historical entries included.
- The runbook's dashboard line says "visitor". Two operator scripts no longer say their results are
  copied into a document; one comment in `editor-core.ts` no longer speaks of a reviewer.
- The implementation notes are kept whole, as asked; none of them linked to the moved documents by
  Markdown link, so nothing here is broken by the move. A link test arrives with WP9.2.

## Gates

Lint clean, typecheck clean, the `dev` and `infra` suites pass; a search for assignment words
outside `docs/implementation/` finds none (the word "submission" in §5 means submitting a program).
