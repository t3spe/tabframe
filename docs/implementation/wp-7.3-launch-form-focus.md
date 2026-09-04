# WP7.3 — The launch form keeps focus

**Branch** `wp/7.3-launch-form-focus` · **Milestone** M7 · **Date** 2026-09-03 · **Ask** Mircea's
third review, item 3: "when I click on a program and try to alter the input I lose focus after one
character".

## What was wrong

The programs panel rebuilt its whole DOM on every state update, and its render signature included
the launch form's text, so typing itself scheduled a rebuild. The textarea a person was typing in
was replaced by a fresh one on the next event, ten times a second; the caret went with it.

## What changed

- **One DOM row per program, updated in place.** `renderPrograms` keeps a map of rows keyed by
  bundle and sets their texts, the running pill, and the button label on each render; rows are
  created when a program appears and removed when it goes. Rows are re-ordered only when the order
  really changed (a program came or went), and the focused element is re-focused afterwards.
- **One persistent form per open program.** "launch…" builds the form once and appends it to the
  row's slot; "cancel" removes it; a successful launch removes it. Nothing in the render path
  touches it, so the caret stays where the person left it.
- **Params are parsed on blur and on launch, never on a keystroke**, and the error ("params must
  be a JSON object", or the JSON parser's message) is shown under the box; a launch that could not
  be sent says "not connected; the launch was not sent" instead of closing the form.
- The `data-launch` / `data-launch-go` hooks the live tests use are unchanged.

## Tests

- `e2e/panels.e2e.ts`: in the demo, with the machine streaming events, sixteen keystrokes go into
  the form at 90 ms each; the textarea keeps the focus, the typed value, and a marker set on the
  node before typing (a rebuilt node would have lost it); the launch goes out and the program is
  queued; bad params are named on blur and never leave the page. The live launch test is unchanged.

## Drift

`docs/design.md` §17 entry of 2026-09-03 (WP7.3).
