# wordcount

Computes the exact top-K most frequent words of *Moby-Dick* in three stages — map, reduce, merge —
reading the previous stage's outputs as files. It is the program that shows the filesystem: a stage
sees what the stage before it wrote, and nothing is recomputed when a core dies mid-stage.

## How it works

- **Corpus.** `in/corpus.txt` (1,220,332 bytes): Project Gutenberg #2701 with the header, footer,
  and licence stripped and typographic characters normalised by `packages/sdk-as/scripts/corpus.ts`;
  `in/ATTRIBUTION.txt` says where it came from. A word is a maximal run of ASCII letters and
  apostrophes, leading and trailing apostrophes stripped, lowercased; everything else separates.
- **Stage 0, `map`.** `mapTasks` tasks over contiguous byte ranges. A task owns the words that start
  in its range: it skips a word straddling its start and reads past its end to finish one straddling
  its end. Its output is eight sections, one per FNV-1a hash partition, each a sorted list of
  `(word, count)`.
- **Stage 1, `reduce`.** Eight tasks, one per partition. Each reads its slice of every map output
  from `/out/0/` and sums, sorted by count descending, then word.
- **Stage 2, `merge`.** One task reads the eight reduce outputs from `/out/1/` and emits the global
  top-K as the bars the dashboard draws, logging the distinct and total word counts.
- **Stage 3.** `plan` ends the execution with no follow-up.
- Integer arithmetic throughout; the only floating point is the final bar values.

## Parameters

| Name | Meaning | Default |
|---|---|---|
| `k` | how many words to keep, 1..4096 | `25` |
| `mapTasks` | how many map tasks to split the corpus into, 1..4096 | `32` |

Imports `tf.stat`, `tf.read`, `tf.list`, `tf.log`, and `env.abort`; it writes nothing. A missing
corpus, a map-output count other than `mapTasks`, or a map output without eight partitions is a
program fault and fails the execution.

## Checked by

`goldens.json` records the parameters, each stage's task counts and output hashes, and the final
bars (`mise run goldens`). `packages/sdk-as/test/wordcount.test.ts` compares stage for stage against
the goldens and against a plain single-pass count in JavaScript, and checks with a property test
that the union of the map outputs equals the single-pass count for any text and any split.

## Attribution

The corpus is *Moby-Dick; or, The Whale* by Herman Melville (1851), public domain, obtained from
Project Gutenberg ebook #2701 with the Project Gutenberg header, footer, and license removed and a
few typographic characters normalized to ASCII; it is therefore not a Project Gutenberg ebook, and
the Project Gutenberg License applies to the ebook as distributed at gutenberg.org, not to this copy.
The attribution ships inside the program's bundle as [`in/ATTRIBUTION.txt`](in/ATTRIBUTION.txt).
