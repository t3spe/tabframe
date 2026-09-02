# WP2.4 — Editor

**Milestone:** M2 · **Branch:** `wp/2.4-editor` · **Merged:** pending · **Packages:** `packages/web`
(editor, compiler worker, build), one export subpath in `packages/sandbox`

## What

The second submission door of design §5.6, in the page: a reviewer opens the editor from the
header, finds the shipped Mandelbrot source, edits it, compiles it **in the browser**, and launches
it on the machine — or drops a `.wasm` built any other way.

- **The compiler in a worker, loaded on demand.** `editor.js` is its own bundle that `host.js`
  imports by a runtime URL when the editor button is clicked, so the dashboard's first paint never
  pays for it. The editor spawns `compiler-worker.js`, AssemblyScript's `asc` 0.28.20 bundled with
  Bun for the browser and minified (1.65 MB). asc's Node-only imports (`fs`, `module`, `path`,
  `url`) sit behind its own runtime check, so the bundle leaves them as dynamic imports that are
  never taken in a worker. Binaryen, which asc imports, is served **as is** next to the worker
  (`binaryen.js`, 13.6 MB): it is almost entirely the compiler's own WebAssembly, a minifying pass
  made it larger (20.8 MB), and the file already runs in browsers. The worker chunk imports it as
  `./binaryen.js`, which a module worker resolves against its own URL. Measured in headless
  Chromium on the development machine: **compiler ready in 1.5 s, Mandelbrot compiled in 1.36 s**
  (the preflight of 2026-09-01 saw 7 s and 0.4 s unminified over a CDN).
- **An in-memory filesystem** (`compiler.ts`). asc's API takes `readFile`, `writeFile`, and
  `listFiles` callbacks; the editor gives it the edited source at `program/assembly/index.ts` and
  the SDK's five files under `node_modules/@tabframe/sdk-as/assembly/` with a `package.json`
  naming `ascMain`, and passes `--path node_modules` — the same resolution the build's
  `--path <program>/node_modules` gives `import ... from "@tabframe/sdk-as/assembly/index"`. The
  flags are the SDK's (`-O3 --runtime stub --noAssert --maximumMemory 256`), pinned by a test
  against `packages/sdk-as/scripts/build-programs.ts`.
- **Byte-identical to the build.** A compile in the page yields the very bytes
  `mise run build:programs` writes: the Bun test compares the buffers, and the browser test
  compares the SHA-256 the page shows to the hash of `programs/mandelbrot/dist/program.wasm`
  (18746 bytes). Same compiler version, same flags, same sources; binaryen's `-O3` is
  deterministic.
- **Diagnostics with positions.** asc's reporter hands over plain objects with byte offsets and a
  normalized path, not line numbers; the editor computes line and column from the virtual file and
  lists `ERROR TS2322: … — assembly/index.ts:19:21`, clickable to jump the cursor. SDK files read
  as `sdk/<name>`.
- **Manifest and params.** Name, view, description, and params are fields seeded from the shipped
  manifest; params must parse as a JSON object, and the manifest goes through the protocol's
  `programManifest` schema before anything is uploaded.
- **Compile → bundle → launch.** `buildBundle` mirrors `packages/control-plane/src/seed.ts`: the
  module, the manifest, any inputs, and a filesystem manifest over the fixed bundle paths
  (`/program.wasm`, `/manifest.json`, `/in/*`), canonical JSON, whose hash is the program — a test
  feeds the same inputs to `seedPrograms` and gets the same bundle hash. The blobs go up with one
  `StoreClient.putMany`: **one `presign` over the observer socket** (D18; `ObserverClient.presign`
  is new — single-flight, matched by hash set, rejected on close or after 30 s), then a PUT per
  blob the store lacks. Then `launch {bundle, params, inherit: null}`. The panel watches the
  cluster feed for the control plane's answer: an `error` activity after the launch (shown as
  "the control plane answered: …"), or a human execution of that name queued or running.
- **The drop door.** A `.wasm` dropped on the panel (or chosen with the file input) is checked with
  the sandbox's own `validateModuleBytes` — size, well-formedness, memory maximum, the import
  allowlist, the required exports — and shown with its hash, imports, exports, and memory
  maximum; junk and empty modules are refused with the reason. The manifest fields apply to it as
  they do to a compiled module; the name defaults to the file's.
- **Embedded sources.** `packages/web/scripts/gen-sources.ts` writes
  `src/program-sources.generated.ts` from the SDK's assembly files and the Mandelbrot source and
  manifest. The web build regenerates it; a test fails when the committed copy is stale. Biome
  skips `*.generated.ts`.
- **Build.** `packages/web/scripts/build.ts` gained the compiler build (minified, externals,
  the binaryen rewrite) and the binaryen copy (cached by size and mtime), and watches the SDK and
  program sources too.

## Evidence

- `packages/web/src/editor-core.test.ts`, `compiler.test.ts`: 39 web tests — sources in sync,
  flags equal the SDK's, the virtual filesystem, params and manifest validation, bundle equality
  with seeding, module inspection both ways, the byte-identical compile, a diagnostic's code and
  line for an injected type error, a missing import as a diagnostic rather than a throw, path and
  position helpers.
- `e2e/editor.e2e.ts`: four browser tests against the real local control plane — compiler load
  and byte-identical compile (hash equality with the build), diagnostics with the line and reset,
  the drop door with a real module, junk, and an empty module, and a launch whose blobs read back
  from the store by hash before the control plane answers.
- Whole suite: 319 unit tests, 94 % of lines; 9 browser tests; Biome and the three type-check
  projects clean.

## Why this shape

- The compiler is loaded only when asked for because 15 MB of assets is not a dashboard cost; it
  is an editor cost, paid once and cached.
- Binaryen is copied rather than bundled because the evidence said so: 13.6 → 20.8 MB after
  minification, and nothing to gain.
- The pure parts live in `editor-core.ts` with no DOM, so the bundle and the validation logic are
  tested under Bun, and the worker imports only types from it — the compiler chunk carries no
  protocol schemas or sandbox code.
- Bundles are built exactly as seeding builds them so that an uploaded program is the same kind of
  object as a shipped one. One difference by design: the page writes the manifest as compact JSON,
  the image ships it pretty-printed, so the same program uploaded from the page and seeded from
  the image are two bundle hashes — two program records — which is correct: different bytes.

## Drift

- §5.6 said the compiler would be "minified and split from binaryen into its own asset"; it is
  split and the compiler is minified, but binaryen itself is shipped unminified on purpose (see
  above). Recorded in the design's drift log.
- `@tabframe/sandbox` gained a `./validate` export subpath so the page validates modules without
  importing the worker adapters.

## Open items for the parent (WP2.3 and later)

- **The core refuses uploaded bundles.** Today `launch` of a bundle the ledger has not seen answers
  `launch-refused: unknown program`; the browser test accepts that answer and, once WP2.3 lands,
  a queued execution. WP2.3's launch path should fetch the bundle manifest by hash, fetch and
  validate the module, `addProgram`, then enqueue — the blobs are already in the store when the
  message arrives.
- **Inputs.** The editor uploads no `/in/*` files yet (word count needs `/in/corpus.txt`); the
  bundle builder takes inputs, the panel has no picker for them.
- **Asset size.** `binaryen.js` is 13.6 MB; the web stack should serve it compressed (CloudFront
  `compress` on the page behaviour) and with a long cache lifetime. Worth checking at WP2.7.
- The editor is a plain `<textarea>` with two-space tabs; syntax highlighting was not in scope.
