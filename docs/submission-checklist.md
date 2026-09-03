# Submission checklist

What is left when the code is done. The items marked **Mircea** are gates only he can pass; the
rest the agent has done or re-runs at the very end.

## Before the flip

- [ ] **Mircea:** the developer-hours column in `docs/timelog.md` and the `<<developer hours>>`
      marker in `docs/rationale.md`; the `<<total hours>>` marker takes the timelog's total.
- [ ] **Mircea:** the video (WP5.3) — narrate the demo script; `mise run demo -- --video` records
      the browser as fallback footage (`test-results/**/video.webm`).
- [ ] Re-export the transcripts (`mise run transcripts`) so the last session is in; scan the output
      (the exporter's counts, then `grep` for a 12-digit number, `lambda-microvm`, `X-aws-proxy-auth`,
      `@`); commit `docs/transcripts/`.
- [ ] Re-run the pre-public scan of the full history: account id, the budget address, any personal
      address, AWS keys, `.env.local`, `cdk.context.json` (WP5.5 in `docs/plan.md` records the first
      pass: clean).
- [ ] `docs/plan.md` "Where we are" says M5; every WP row in `docs/implementation/README.md` exists.
- [ ] CI on `main` green (`gh run list --branch main --limit 1`).

## The flip and after

- [x] The budget notification path is confirmed (the one-cent test budget's email arrived on
      2026-09-03 at $2.55 month-to-date; the test budget is deleted, the real one stays).
- [x] **Mircea (decided 2026-09-02):** the machine **stays up** for the review period — hourly
      rotation while awake, two cores while anyone watches, asleep otherwise; the README says so.
      `mise run down` remains the way to turn it off.
- [ ] **Mircea:** make the repository public (GitHub → Settings → Danger zone), then check the
      public page renders the README and the web origin in it answers.
- [ ] Submit: the repository URL, the rationale (`docs/rationale.md`), the video, and a note that
      the transcripts are in `docs/transcripts/`.
