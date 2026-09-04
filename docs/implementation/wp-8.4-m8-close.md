# WP8.4 — M8 close: the deploy after the loops, three demo passes, the records

**Branch** `wp/8.4-m8-close` · **Milestone** M8 · **Date** 2026-09-04/05 · **Ask** the tail of Mircea's
review-loops goal: once the three loops are merged, deploy once and run the unattended demo three times.

## What happened

- **The first deploy failed on a CloudFront rule.** `TabframeCore` refused the blob response-headers
  policy loop 1 had written: `Content-Security-Policy` is a security header and cannot be a custom
  header. CDK synthesises the shape without complaint, so no loop and no CI run could see it; the
  stack rolled back cleanly (`UPDATE_ROLLBACK_COMPLETE`) and the running machine was untouched
  (generation 125, image version 24, asleep). The fix moves the header into the security block; a
  synth test now refuses any security header among a policy's custom headers.
- **The second deploy** went through: all four stacks (`TabframeCore` with the RETAIN buckets and
  the header policies, `TabframeImage` with image version 25, `TabframeFleet` with the alarms, the
  canary, the ten-minute rotate and the scoped launch permission, `TabframeWeb` with `no-cache`
  objects), then `up`: a rotation with a live handover onto **generation 127**, four clients drained.
  `/health` on the new control plane shows the whole build stamp (`49b9647`, `main`, not ungated),
  image version 25.0, `authoritative: true`, and two cores linked by their tokens. 1334 s end to end,
  of which the guard, the build, and the whole test suite were the first eight minutes.
- **Three unattended demo passes** DEMO_RESULT

## Records

- `docs/plan.md`: M8 lines for the deploy and the demo passes; "Where we are" at the close.
- `docs/rationale.md`: the "Three review loops" section (what the loops did and taught).
- `docs/timelog.md`: the build row's span.
- Transcripts re-exported with the loop-3 scrubber (access-key ids, credential fragments, the
  operator mask), leak scan clean.
- Memory of the session updated; the reviewer transcripts (15) copied to the durable directory.
