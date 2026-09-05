# WP9.2 — The documents read for a stranger; a README for each program

**Branch** `wp/9.2-docs` · **Milestone** M9 · **Date** 2026-09-04 · **Ask** Mircea: review all the
documents, make sure they make sense, are up to date, and are very easy to follow; keep the
historical notes intact; give each program a short README that says what it is and how it works.

## Method

A fresh technical-writing reviewer read the remaining documents in a stranger's order — README,
design record, runbook, walkthrough, feasibility note, the SDK guide, the page's copy, the tooling
headers — checking every statement it could against the code, and returned twenty findings plus a
reading order and the shape of an index. Everything it found landed here except the two items that
belong to code (the page's "kind" column and the files panel's repeated paragraph, and the mise task
descriptions and CI guard), which the structural pass of WP9.5 carries.

## What changed

- **README.** The five-click tour is a list; the evidence table points at the implementation notes
  that hold the numbers; the daily-aging test counts are gone in favour of what CI runs; "Limits"
  leans on the design record, not the plan; the architecture list names the orchestrator (the
  runtime is "Node.js"); "Deploying it" keeps the five operator commands and the guard's needs
  (`gh` logged in) and sends everything else to the runbook; "Reading the repository" is one
  paragraph pointing at the new index; one name for the MicroVMs.
- **`docs/README.md`** (new): the documents in reading order, with the settled vocabulary.
- **Design record.** §9.7 says what the code does for the fifteenth client (the machine-full code,
  not a 503); D1 and §3 no longer defer to the rationale; the contents list says "History"; §11.3
  and §11.4 list what exists (four stacks, tinygpt's `train/`); §11.5 lists the documents that exist.
- **Runbook.** `/health` is open on the private port (`/diag` needs the secret); the deploy step
  names the guard's needs; the cost section explains what an untouched machine converges to; the
  plan references and the work-package tags in prose are gone (the incident rows keep their fixes).
- **Walkthrough.** The header's host count says the cloud cores are one host; the process line is a
  date.
- **Feasibility note.** Past tense; one memory cap stated with where each is enforced; "as planned"
  is now "what was planned, and what differed".
- **Program READMEs** (WP9.4): `programs/README.md` and one per program — what it computes, the
  stages and their tasks, the parameters, inputs and outputs, and what checks it — from the code and
  the reviewer's reading of it.
- **`e2e/README.md`** describes the nine suites as they are.
- **`docs/links.test.ts`** (new): every relative Markdown link and anchor in the repository resolves;
  the index and the program READMEs exist. It runs with `bun test`.
- The implementation notes are untouched beyond one sentence in their index saying they are history.

## Left to the code pass

The page's nodes table prints the wire's `core` for a MicroVM and the files panel says one thing
twice (WP9.5, web); `mise tasks` descriptions carry milestone prefixes and CI guards a simulation
file that exists (WP9.5, tooling); the SDK README's tooling section changes with the host swap
(WP9.5, programs) and is corrected when that lands.
