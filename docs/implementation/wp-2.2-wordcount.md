# WP2.2 — Word count program

**Milestone:** M2 · **Branch:** `wp/2.2-wordcount` · **Merged:** pending · **Packages:**
`programs/wordcount`, `packages/sdk-as` (bars builder, staged host, corpus and goldens scripts),
`packages/protocol` (bars payload), `packages/infra` (image staging of inputs)

## What

The second demo program, and the first with more than one stage (design §5.6): a word count over
Moby-Dick as a three-stage map/reduce/merge, with a `bars` view.

- **`programs/wordcount/assembly/index.ts`.** `plan` lays out the stages from the params
  (`mapTasks`, default 32; `k`, default 25): stage 0 `map` is `mapTasks` byte ranges of
  `/in/corpus.txt` (the corpus length comes from `fs.stat` at plan time; a missing corpus is a
  program fault right there); stage 1 `reduce` is one task per partition, eight of them; stage 2
  `merge` is one task; stage 3 is `done` with no follow-up — word count is not a loop.
- **Map.** A task owns the words that *start* inside its range. It reads its range, and if the byte
  before the range is a word byte it skips the word that straddles its start (the previous task
  owns it); if the last byte is a word byte and the range does not end the corpus, it reads on past
  its end in 4 KiB chunks until a separator, so a word longer than any buffer is still finished
  and no word is split or double counted. Counts are bucketed into eight partitions by FNV-1a
  (32-bit, offset basis 2166136261, prime 16777619) of the word's bytes, modulo eight. Output:
  `u32 partitions | 8 × (u32 offset, u32 length) | sections`, each section
  `u32 count | count × (str word, u32 count)` sorted by word, so a reducer reads the header and
  then exactly its slice.
- **Reduce.** Lists `/out/0/`, checks the count matches the plan, reads each output's header and
  its partition's slice, sums, and emits the partition sorted by count descending then word
  ascending. Partition sums do not depend on how the map was split, so the reduce outputs are
  byte-identical for any `mapTasks` (a test checks this).
- **Merge.** Reads the eight reduce outputs, ranks every word, and emits the global top-K as the
  `bars` payload. Exact for any K, because partitions are disjoint and each reducer emits its
  whole partition. Logs "N distinct words, M in total; top K".
- **The word rule**, on bytes: a word is a maximal run of ASCII letters and apostrophes, with
  leading and trailing apostrophes stripped, lowercased. Digits, punctuation, whitespace, and any
  non-ASCII byte separate words. "Ahab's" and "don't" are one word each; "'tis" is "tis"; "''" is
  nothing; "abc123def" is "abc" and "def". Deterministic by construction: integers only until the
  final bar values, and every output sorted. Linguistic nicety lost on purpose.
- **The corpus.** `programs/wordcount/in/corpus.txt` is Moby-Dick from Project Gutenberg ebook
  #2701, fetched by `packages/sdk-as/scripts/corpus.ts` (`mise run corpus`) with a plain request
  and no custom headers, the header, footer, license, and the "Original Transcriber's Notes"
  paragraph stripped, CRLF made LF, a byte-order mark dropped, and — because the word rule is
  bytes — typographic apostrophes and quotation marks made ASCII (so "Ahab’s" stays one word), the
  em dash made `--`, and Melville's handful of accented letters and ligatures (æ, œ, é, è, â)
  made plain letters. 1 220 332 bytes, 21 922 lines; the Hebrew and Greek words in the Etymology
  stay as they are and count as separators. `in/ATTRIBUTION.txt` next to it names the source and
  its public-domain status and says this copy is not a Project Gutenberg ebook; it ships in the
  bundle as `/in/ATTRIBUTION.txt`, so the attribution travels with the data.
- **`bars` payload** (`packages/protocol/src/abi.ts`, mirrored in `packages/sdk-as/assembly/bars.ts`):
  `"TFBR" u32 version=1 | u32 count | count × (str label | f64 value)`. `encodeBars`/`decodeBars`
  with caps (4096 bars, 256-byte labels, 1 MiB) and a finiteness check — a NaN value would make
  identical programs disagree byte for byte, so it is refused. The SDK builder is
  `bars().bar(label, value)…toBytes()`, and it aborts on a non-finite value. The dashboard's `bars`
  rendering is WP2.5's; this is the contract it decodes.
- **Staged host** (`packages/sdk-as/scripts/host.ts`, `runStaged`): runs a whole execution the way
  the control plane would — plan each stage, run its tasks in fresh instances against the
  filesystem as of the stage start, land outputs at `/out/<stage>/<task>`, fold writes with
  conflict detection, stop at `done` — returning every stage's outputs, hashes, and logs.
  `goldens.ts` uses it for non-`tiles` programs and writes `programs/wordcount/goldens.json`: every
  stage's per-task hashes, the final payload's hash and decoded bars, the follow-up. `mise run
  goldens` now does both programs.
- **Image staging.** `stage-image.ts` copies `programs/<name>/in/*` next to the compiled program,
  so the image carries the corpus and `seed.ts` (which already read `in/`) bundles it as `/in/*`.

## Evidence

- `bun test packages/sdk-as packages/protocol` → 81 pass. New tests:
  - `wordcount.test.ts` (the program compiled at test time with the build's compiler and flags):
    imports are exactly `env.abort`, `tf.list`, `tf.log`, `tf.read`, `tf.stat` (no write, no
    clock, no network), the four exports, memory maximum 256, module under 64 KB; manifest and the
    bundle's inputs; stage 0 ranges contiguous and covering the corpus once; stages 1–2 inputs;
    `done` with no follow-up; params clamped (1–4096 map tasks, 1–4096 for K, junk falls back); a
    missing corpus is a program fault. The word rule on a text with every kind of separator,
    checked against a plain JavaScript count with the same rule (`wordcount-reference.ts`); a
    boundary inside a word owned once by the task where it starts; empty ranges; a 10 000-letter
    word longer than the tail chunk finished across boundaries and owned by nobody else; FNV-1a
    partitions and sorted sections; a **property test** — random texts with apostrophes, digits,
    punctuation, non-ASCII bytes, 5000-letter words, and no trailing newline, split into 1–9
    tasks — the union of the map outputs equals the single-pass count, 40 runs. Reduce outputs are
    disjoint, sorted, and sum to the reference; the merge is the exact top-K; the merge log; the
    filesystem the control plane would fold; two executions byte-identical; `mapTasks` 1 and 23
    give identical reduce outputs and final bytes. **Goldens:** the whole corpus single-threaded
    matches `goldens.json` stage for stage, and the goldens' top-25 equals the JavaScript
    reference's top-25 (`the` 14 529, `of` 6 620, `and` 6 446, …).
  - `corpus.test.ts`: marker stripping, the transcriber's notes, normalization to the byte, the
    source fallback order, and failure when nothing answers.
  - `abi.test.ts`: bars round trip, the magic, every cap, NaN and infinity refused, trailing bytes,
    wrong magic, truncation, and a property over random finite bars.
- The corpus: 17 358 distinct words, 216 541 in total under the rule above (the longest,
  "uninterpenetratingly", 20 letters); the whole execution runs in about 0.6–1.2 s
  single-threaded under Node.
- Module: 20 655 bytes. `bunx tsc` on the root project clean; Biome clean on every touched file
  (run with `--vcs-use-ignore-file=false` inside the worktree).

## Why this shape

- Ownership by *start position* is the one rule that makes ranges a partition of the words with no
  coordination: every word starts exactly once, so it is counted exactly once whatever the split,
  and the property test can say so.
- Reducers emit whole partitions rather than local top-Ks. Local top-Ks would also give an exact
  global top-K (a word in the global top-K is in its partition's top-K), but whole partitions make
  the reduce outputs independent of K and byte-identical across splits, which is a stronger
  check for the churn simulation, and they are small (about 2 500 words each).
- The bars payload is binary like every other ABI format, not JSON: programs have no JSON
  encoder, and identical logic must give identical bytes.
- Normalizing the corpus at build time rather than in the program keeps the program's word rule
  a byte rule with no multi-byte cases at range boundaries; the corpus is a fixed artifact and the
  script that makes it is committed.

## Drift

- **Attribution file inside the bundle.** The plan said "attribution file"; it lives at
  `in/ATTRIBUTION.txt` and therefore ships as a bundle input. Deliberate: the text and its
  provenance stay together wherever the bundle goes, and it costs a few hundred bytes.
- **Corpus normalization.** The design said "boilerplate stripped"; this also normalizes
  typographic characters and a few accented letters to ASCII, and removes the transcriber's notes.
  Recorded in the design's drift log.
- **`bars` byte format** defined here (the design named the view but not the bytes).

## Open

- The dashboard does not draw `bars` yet (WP2.5); `decodeBars` is what it will call on the final
  task's output. A `text` view payload is still just raw bytes.
- `goldens.ts` keeps its Mandelbrot-shaped `--all`/`--preset` timing flags; a general timing tool
  for staged programs is not needed yet.
- The reduce and map stages are fast (milliseconds a task); the demo value of word count is the
  staged pipeline and the persisted filesystem, not compute. `mapTasks` can be raised to make the
  cluster visibly busy.
