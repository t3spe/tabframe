# WP1.5 — AssemblyScript SDK and the Mandelbrot program

**Milestone:** M1 · **Branch:** `wp/1.5-sdk-mandelbrot` · **Packages:** `packages/sdk-as`, `programs/mandelbrot`

## What

The first real program and the SDK it is written against (design §5.3, §5.5, §5.6).

- **`packages/sdk-as/assembly/`** — the SDK, mirroring `packages/protocol/src/abi.ts` byte for byte:
  `readRunInput`, `readPlanInput` with `Params` (key → JSON text; `getString`/`getI32`/`getF64`/
  `getBool` with fallbacks, quoted numbers accepted, arrays and objects passed through raw), the
  `stage(name).canvas(w, h).task(bytes)` / `.taskAt(bytes, x, y, w, h)` builder, `done(next)`,
  `emit`, `alloc`, `ByteWriter`/`ByteReader` for programs' own inputs, and the five `tf` imports
  wrapped as `fs.stat/read/readRange/write/list` and `log`.
- **`programs/mandelbrot/`** — `plan` stage 0 lays out 640 tiles of 64×64 over a 2048×1280 canvas in
  centre-out order, each task self-contained (frame centre, scale, maxIter, palette, supersampling,
  tile rect) with a placement rect; stage 1 returns `done` with the next preset so the default loop
  advances. `run` renders a tile: escape-time in f64 with smooth coloring, supersampled and
  averaged, three palettes, interior black, alpha 255, never NaN. `manifest.json` declares the
  `tiles` view and `{preset: 0, palette: "ocean"}`.
- **Scripts** — `build-programs.ts` (`mise run build:programs`, now back in `mise run build`),
  `goldens.ts` (`mise run goldens` writes `programs/mandelbrot/goldens.json`; `--all --sample N`
  and `--preset N` are the pacing tools), and `host.ts`, a minimal Node host with the five imports
  over an in-memory filesystem, used by the goldens script and the tests and reusable by the
  churn simulation.
- **README** in the SDK package: how to write a program, the compiler flags, the allowed imports,
  the byte formats.

## How

- Programs import `@tabframe/sdk-as/assembly/index` and depend on the SDK as a workspace package;
  asc resolves the subpath through the program's own `node_modules` (`--path`), because asc's
  `ascMain` lookup does not resolve scoped package names. `--baseDir` is the repo root.
- Flags: `-O3 --runtime stub --noAssert --maximumMemory 256`. The stub runtime is a bump allocator
  with no collector, which is exactly right for a fresh instance per task; 256 pages (16 MiB) is
  the sandbox's reference memory maximum.
- The pacing knob is per-preset supersampling (`ss` = 2–6 orbits per axis per pixel) plus
  `maxIter`. Regions that escape quickly cannot be slowed by iteration count alone, and raising
  `maxIter` on interior-heavy regions makes single tiles run for seconds, which would trip the
  scheduler's straggler deadline. Supersampling scales every tile by `ss²` and antialiases the
  boundary for free.
- Centre-out ordering sorts tile indices by squared distance from the canvas centre with a
  comparator over a module-level array (AssemblyScript closures cannot capture locals).

## Measurements

Single-threaded under Node's V8 on the development machine, which was also running the parent's
deploys and tests at the time; browsers will differ. Sampled estimates from `goldens.ts --all
--sample 32` after tuning:

| Preset | maxIter | ss | ms/tile median | ms/tile max | est. frame |
|---|---|---|---|---|---|
| 0 overview | 6000 | 2 | 3.7 | 1282 | 50 s |
| 1 seahorse valley | 13000 | 6 | ~90 | ~220 | ~60 s |
| 2 elephant valley | 1200 | 2 | 59 | 197 | 55 s |
| 3 triple spiral | 6500 | 4 | 59 | 381 | 63 s |
| 4 antenna minibrot | 750 | 2 | ~100 | ~130 | ~62 s |
| 5 double spiral | 30000 | 4 | 75 | 228 | 62 s |
| 6 feigenbaum | 9000 | 5 | ~90 | ~190 | ~62 s |
| 7 julia island | 3400 | 3 | ~95 | ~175 | ~64 s |

The full goldens run of preset 0 (all 640 tiles, one instance per tile) measured 106 s on the
loaded machine, median 3.8 ms, max 1.32 s. Presets 1, 4, 6, 7 were retuned after the last full
sampling pass; their rows are extrapolated. WP4.3 re-measures pacing in the browser.

Module: 18 746 bytes. Imports: `env.abort` only (Mandelbrot touches no files). Exports: `alloc`,
`memory`, `plan`, `run`. Memory maximum: 256 pages.

## Evidence

- `bun test packages/sdk-as` → 17 pass. An echo program compiled at test time proves both
  directions of every format against `@tabframe/protocol`: run input fields and bytes; a stage with
  canvas and placements decoding on the TypeScript side; a stage without either; `done` echoing
  every param raw and the decoded scalars, quoted numbers, and fallbacks; the filesystem imports
  (read, range, write, list, stat, log, hints) against the Node host; the import allowlist, the
  four exports, and the declared memory maximum. The Mandelbrot tests: only `env.abort` imported,
  the four exports, memory maximum 256, module under 32 KB, a valid manifest; stage 0 with 640
  placed tiles covering the canvas exactly once in centre-out order; stage 1 done with the next
  preset and wrap-around, unknown palettes falling back; a tile is 16 384 bytes with alpha 255 and
  both interior and exterior pixels; two runs byte-identical; palette changes the bytes and mono is
  grey; a deterministic sample of every 40th tile matches `goldens.json`.
- Biome and all three `tsc` projects clean (Biome run with `--vcs-use-ignore-file=false` inside the
  worktree, see Open).

## Dependencies introduced

| Package | Version | Why |
|---|---|---|
| `assemblyscript` (root, dev) | 0.28.20 | compiles programs at build time and in tests; the same pinned version the in-page editor will bundle |

## Drift

- **ABI details pinned with the sandbox worker (WP1.4):** `stat` → size or −1; `read` → bytes
  copied, 0 at EOF, −1 not found, −2 bad args; `write` → 0, −2 bad args, −3 over cap; `list` →
  total byte length, copied only when it fits, sorted paths joined by `\n` without a trailing
  newline; own writes shadow the manifest, last write wins; `log` has no return; strings cross the
  boundary as UTF-8 at (ptr, len); entry points return a pointer to `{outPtr: u32, outLen: u32}`.
  The SDK implements exactly this and the README documents it.
- **Import form:** programs import `@tabframe/sdk-as/assembly/index` (a subpath), not the bare
  package name, because asc does not resolve `ascMain` for scoped packages. Design §5.6 said
  "against a small SDK"; the path is an implementation detail, recorded here.
- **Pacing knob:** the design spoke of maxIter per preset; supersampling per preset joins it for
  the reason above.

## Open

- Inside a worktree under `.claude/`, `mise run lint` processes zero files because the root
  `.gitignore` ignores `.claude/` and Biome honors it; run `bunx biome check
  --vcs-use-ignore-file=false packages programs` there instead. Not an issue on `main` or in CI.
- Frame pacing is measured under Node on a busy machine; WP4.3 re-tunes in the browser.
