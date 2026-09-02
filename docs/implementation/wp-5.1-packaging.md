# WP5.1 — Packaging: README, rationale, transcript export

**Milestone:** M5 · **Branch:** `wp/5.1-packaging` · **Merged:** pending · **Files:** `README.md`,
`docs/rationale.md`, `packages/dev/src/transcripts.ts`, `scripts/transcripts/export.ts`,
`mise.toml`, `tsconfig.json`, `.gitignore`

## What

Three deliverables of M5, each its own commit, drafted for the parent session to review.

- **`README.md`** (WP5.1, done): what Tabframe is, why it looks the way it does — the three
  constraints, taken literally — the architecture in one ASCII diagram with a line per package,
  a table of what was measured against the deployed machine with links to the three verification
  records, the limits stated plainly (the sixteen-connection endpoint quota first, then the single
  active control plane, the sandbox's scope, and what was cut on purpose), how to run it locally
  and how to deploy it with the `mise` tasks that exist, the reading guide to `docs/`, the license,
  and the corpus attribution. The deployed URL is in it; no account id, endpoint hostname, token,
  or address is.
- **`docs/rationale.md`** (WP5.2, draft): the five required questions in order — why this theme,
  what is non-obvious, key decisions and trade-offs, how it would be extended, how long it took —
  answered from what was built and measured rather than from the original design. The non-obvious
  section and the trade-offs come from the drift log and the verification records: the checksum
  that had to be a signed header, the endpoint quota and the handover that must be optional, the
  bundled worker, seeding by hash, the default-loop backoff, released attempts, two-node
  agreement. The scoping decisions are owned in the first person, as the assignment asks. **Two
  markers are left for Mircea:** `<<total hours>>` and `<<developer hours>>` in the last section,
  since the time log's developer column is his and its later rows are not yet entered; the sentence
  is written so the numbers drop in. The draft also states, factually, that the build was an AI
  coding agent working under his direction and that the transcripts are submitted with the code.
- **Transcript export** (WP5.4, tool done; the export itself pending review):
  `packages/dev/src/transcripts.ts` renders a Claude Code session transcript (JSONL, one event per
  line) as Markdown — user and assistant turns in full, thinking as a quoted block, tool calls
  shown by what matters (the command, the path, the description; never the whole input), tool
  results cut to their first forty lines with a `… (N more lines)` marker, attachments and system
  notices as one-liners, everything else skipped — and **scrubs** it: presigned URLs
  (`X-Amz-Signature`) whole, JWE/JWT-shaped tokens (including the `..` form the MicroVM proxy
  uses), MicroVM endpoint hostnames, Lambda function URL hostnames (added to the asked-for list:
  the session URL is semi-public but there was no reason to keep it), `microvm-<uuid>` ids,
  twelve-digit account ids, and every email address, in an order that cannot create a new match
  by replacing an old one. `scripts/transcripts/export.ts` runs it over every `*.jsonl` and
  `*.output` in `TABFRAME_TRANSCRIPTS_DIR` (default `~/homework/tabframe-transcripts`; files under
  a kilobyte are a bash task's output, not a session, and are skipped) plus the main session file
  (`TABFRAME_MAIN_TRANSCRIPT`), writes `docs/transcripts/<id>.md` and an `index.md`, and prints
  one summary line per session. `mise run transcripts` runs it. `docs/transcripts/` is
  **gitignored** with a comment saying so: nothing exported is committed until a person has read
  it. `tsconfig.json` now includes `scripts/**/*.ts`.

## Tests

`packages/dev/src/transcripts.test.ts`, ten cases on synthetic input only — the real transcripts
are never read by a test: every scrub pattern replaces its own kind and nothing else; a presigned
URL disappears whole with the account id and token inside it; things that look like secrets but
are not (local MicroVM names, the CloudFront domain, thirteen- and ten-digit numbers, a bare
`eyJ`, a blob hash) are left alone; scrubbing is idempotent; truncation keeps short text and counts
what it cuts; tool calls are described by command, path, or description with a cap; a small
transcript in the real files' shapes renders turns in order with labelled, truncated results and
nested fences handled; nothing secret survives the export and the summary counts what was
scrubbed; a label overrides the id and an empty file still renders.

Lint, the three type-check projects, and the suite are green on the branch; CI is the gate the
parent checks before merging.

## Why this shape

- The scrub happens once, on the rendered Markdown, rather than per field: coverage does not
  depend on remembering every place a secret could hide in the event shape.
- Results are truncated and tool inputs summarized because the point of the export is the
  conversation — the judgment, the questions, the decisions — not a log replay; the code is in
  the repository and the evidence is in the WP documents.
- The export is a tool plus a gitignored directory rather than a commit, because the directive
  was explicit: a person reads the output before any of it lands.

## Left for the parent

- Fill `<<total hours>>` and `<<developer hours>>` in `docs/rationale.md` once `docs/timelog.md` is
  complete; the rows for the M2–M4 sessions of 2026-09-02 are not in the log yet.
- Run `mise run transcripts`, read the output, remove the `docs/transcripts/` line from
  `.gitignore`, and commit — that is WP5.4's remaining step. The main session's raw file is about
  9.5 MB; the export is bounded by the truncation but still long.
- Tick WP5.2 and WP5.4 in the plan when those two are done; WP5.1 is ticked here.
