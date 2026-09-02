# WP4.9 — Seeding follow-through and snapshot diet

**Branch** `wp/4.9-seeding-snapshot-diet` · **Milestone** M4 · **Date** 2026-09-02

## Why

The first `mise run verify:m1` on the paced image (WP4.3) rendered a frame in which 66 of 640 tiles
matched the goldens. The machine was fine; it was rendering the *previous* Mandelbrot. Seeding is by
bundle hash (WP2.7), so the deploy had added the paced program as a second `mandelbrot` record, but
the default loop still pointed at the old bundle, and only the default loop's follow-ups continue on
their own (D19): the old frame's chain never ended, and the runbook launched the first `mandelbrot`
it found — the old one. The dashboard listed two programs with one name. Meanwhile `/health` showed
a 917–967 KB gzipped snapshot every five seconds at 1 925 tasks — half of what WP4.3 started from,
but five times its estimate.

## What changed

### The image owns the names it ships

`seed()` in the control plane still adds unknown bundles, then:

- **retires** every record under a shipped name whose bundle is not the shipped one — the previous
  deploy's version, or a drop that borrowed the name — with a `programRetired` core event;
- **moves the default loop** to the shipped default program with a `setDefaultLoop` event when
  there is no loop, or the loop's bundle is gone or was just retired. A loop that points at a live
  bundle of another name is left alone.

In the core a retired `ProgramRecord` (`retired: true`) is hidden from the snapshot's program list
and from `/health`, refuses launches (`launch-refused: program retired`, human or automatic, so the
old frame's follow-up chain ends), and stays only while an execution still refers to it — `fill`
needs its module and inheritance its files. `pruneExecutions` drops it once nothing does. The
dashboard handles the new observer message by removing the program and noting it in the activity.

The runbook now picks the newest `mandelbrot` by `addedAt`, which is what the goldens belong to.

### The file maps go with the tasks

What kept the deployed snapshot near a megabyte was not the tasks any more but each ended
execution's `files`: 640 entries of hash and size per frame, 32 frames deep, some 21 000 entries of
distinct hashes that gzip cannot fold. `pruneExecutions` now clears the map of every ended execution
beyond the two most recent (`KEEP_ENDED_TASKS`) along with its tasks; the root hash stays.

That was only safe because inheritance stopped depending on the ledger's copy: `enqueue` no longer
merges the inherited execution's map at launch time, and `onInheritRoot` — which already fetched the
inherited root to check it still existed — now parses the fetched manifest and merges the bundle's
files over it. The blob is the source of truth, the ledger's map a cache. A root that fetches but is
not a manifest is treated like a missing one: an `expired-root` warning and a run from the bundle.

## Tests

- `packages/core/src/programs.test.ts`: a retired program is announced, leaves the snapshot, and
  is dropped once nothing refers to it; kept while an execution refers to it, hidden and refusing
  launches, dropped by the prune afterwards; `setDefaultLoop` moves the loop — the old bundle's
  follow-up is not queued, the new bundle is launched on the next tick, the old record stays while
  its finished frame refers to it.
- `packages/core/src/filesystem.test.ts`: the inherited map is read from the root's manifest blob
  (the existing test now feeds the real manifest); an execution whose map was pruned is still
  inherited from its root; a root that is not a manifest warns like a missing one.
- `packages/core/src/loop.test.ts`: the prune clears the older frames' file maps, keeps their
  roots, and leaves the two most recent maps alone.
- `packages/control-plane/src/adopt.test.ts`: a deploy that ships a changed program to a machine
  adopting its predecessor's ledger retires the old bundle, lists one `mandelbrot`, and moves the
  default loop to the new bundle.
- Protocol round trip for `programRetired`; the dashboard reducer removes a retired program.

## Drift

- New core events `programRetired` and `setDefaultLoop`; new observer message `programRetired`;
  `ProgramRecord.retired`.
- Shipped program names are reserved: a same-named drop is retired at the next seeding (a
  rotation or a deploy).
- `pruneExecutions` clears file maps beyond `KEEP_ENDED_TASKS`; `onInheritRoot` merges from the
  fetched manifest instead of the ledger's copy.

## Left for the parent

- Deploy, rotate, `mise run verify:m1` on the new image; record the snapshot size after this in
  the runbook.
