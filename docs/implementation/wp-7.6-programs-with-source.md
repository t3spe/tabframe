# WP7.6 — Every program in the editor, with its source

**Branch** `wp/7.6-programs-with-source` · **Milestone** M7 · **Date** 2026-09-04 · **Ask** Mircea's
third review, item 10: "I don't see all the programs in the editor". Decision D5 (recommended): a
program's source lives in the content-addressed store and its manifest names the hash.

## What was wrong

The editor's select listed three embedded examples and never looked at the machine, although it
already held the machine's snapshot for the pause. tinygpt and every upload were missing, and an
upload's source was kept nowhere, so it could not have been reopened even if listed.

## What changed

- **The manifest names the source.** `programManifest.source` (optional, a sha-256) and
  `programView.source` (nullable) in the protocol; the core's program view carries it; the web
  state's `ProgramInfo` has it. The source is a blob in the store, never a file of the bundle, so a
  program cannot see its own text.
- **The seeder stores every shipped program's source.** `discoverPrograms` finds
  `assembly/index.ts` (the repo) or `source.ts` (the image, which `stage-image.ts` now copies), and
  `seedPrograms` puts it in the store and re-serialises the manifest with the hash. Mandelbrot,
  word count, and tiny GPT arrive with their sources; nothing is embedded for them.
- **A launch from the editor uploads the source with the module.** `buildBundle` takes the source
  bytes as an extra blob and input references (`InputRef`: path, hash, size) as files that are
  named but not uploaded; `buildManifest` accepts the source hash. The text uploaded is the text the
  module was compiled from, not what the box holds at launch time.
- **The select lists every program on the machine, then the examples.** Two option groups. Opening
  a machine program fetches its bundle from the store, then its manifest; with a source, the text
  fills the box, the fields fill from the manifest, the copy is named `<name>-edit`, its inputs are
  kept by hash for the launch ("1 input file kept by hash, nothing to re-upload"), and compile is
  on while launch waits for a module. Without a source (a dropped `.wasm`), the module itself is
  loaded, compile is off, and launch runs it as it is with the params on the right. Reset returns to
  the machine's copy. The list rebuilds only when the machine's programs change and keeps its
  selection.

## Tests

- `packages/protocol`: the manifest's `source` is optional and must be a hash.
- `packages/control-plane/src/seed.test.ts`: the fixture program's source is stored and named by
  the manifest blob the bundle points to; a program without one has none; the source is not a file.
- `packages/web/src/editor-core.test.ts`: a bundle with a source and an input reference names the
  input without uploading it and uploads the source without naming it.
- `e2e/editor.e2e.ts` (live): hello compiled and launched under a name is listed under "on the
  machine" after a reload and reopens with the same text, fields, and `-edit` name; a dropped
  module is listed as "no source", loads its module, and disables compile.
- `e2e/demo.e2e.ts` (live): the editor opens tiny GPT from the machine with its weights kept by hash.

## Drift

`docs/design.md` §5.1 (the manifest's `source`), §5.6, §17 entry of 2026-09-04 (WP7.6). The plan
said tinygpt's source would be embedded at build like the others; the store makes that unnecessary,
so the examples stay three and the machine's programs come from the machine.
