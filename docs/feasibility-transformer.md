# Feasibility: a small transformer in WASM, predicting the next token on the cores

**WP6.5** · 2026-09-03 · the question: can a Tabframe program be a small transformer that predicts
the next token, and is it worth building?

## Short answer

Yes, for a *small* one: a character-level GPT of one to two million parameters fits the sandbox,
runs a token in a few milliseconds on a core, and gives identical bytes on a browser tab and a
MicroVM, so the redundancy toggle verifies it like any other task. What parallelises is the
prompts, not the sequence. GPT-2 small does not fit the sandbox's memory cap. Training is out of
scope: weights are an input file. A prototype is a day: train a tiny model offline on the
Moby-Dick corpus the repository already carries, ship int8 weights as a bundle input, write the
forward pass in AssemblyScript, and let a stage of tasks generate continuations for a list of
prompts into the text view.

## What a program is allowed

| Constraint (design §5, §8.4) | Value | What it means for a transformer |
|---|---|---|
| Memory maximum a module may declare | 256 pages = **16 MB** | weights, activations, and the KV cache all live here; f32 weights of *N* parameters need 4 *N* bytes |
| Module size | 8 MB | the code; irrelevant, a forward pass is a few KB |
| Bundle inputs | files under `/in/`, any size within the 256 MB filesystem cap | the weights file; read once per task with `fs.read` (one round trip per read, so read it whole) |
| Task inline input | 16 KB | a prompt and a token count fit; more goes through the filesystem |
| Output per task | 16 MB | the generated text |
| Deadline | median compute × factor, floor 2 s, killed at the deadline | a task must finish its continuation in seconds |
| Determinism | no clock, no randomness, no NaN; plain f32/f64 arithmetic | inference is arithmetic only — sampling needs a seed *from the params* (a counter-based PRNG in the program), which keeps it deterministic |

## What fits

- **Parameters.** With f32 weights and room for activations and a cache, about **2 M parameters**
  is the comfortable ceiling in 16 MB (8 MB of weights); int8 weights dequantised on the fly push
  that to about 8 M at a cost in the inner loop. GPT-2 small (124 M) is 500 MB in f32 and 124 MB
  in int8 — out by an order of magnitude; raising the cap is a design change for a machine whose
  cores are browser tabs.
- **Speed.** A plain-loop f32 matrix–vector product in WASM, measured on this laptop's core
  (AssemblyScript `-O3`, no SIMD):

  | d | one W·x | rate |
  |---|---|---|
  | 256 | 0.23 ms | 285 M MAC/s |
  | 512 | 2.9 ms | 90 M MAC/s |
  | 1024 | 10.6 ms | 99 M MAC/s |

  A token costs about 2 × parameters multiply-adds, so a 1 M-parameter model runs a token in
  roughly 4–10 ms here, a 2 M one in 8–20 ms; a browser tab or a MicroVM core is two to four times
  slower, so **a 200-token continuation is one to ten seconds** — the same shape as a Mandelbrot
  tile at the heavy end, within a task's deadline once the median has adapted. SIMD (`v128`) would
  roughly quadruple the rate and is deterministic too, but the SDK does not use it yet.
- **Memory traffic.** The whole model is read per task. A 4–8 MB weights file from the store, once
  per task, is the same order as a word-count map task reading a slice of the corpus; the cores'
  blob reader caches nothing across tasks, so a stage of *k* continuations reads the weights *k*
  times. Fine at these sizes.

## What parallelises

A single sequence is serial: token *t* + 1 needs token *t*. The unit of work that fits Tabframe's
model is a **continuation**: one prompt, one seed, *n* tokens — one task. A stage of tasks then
parallelises across prompts, seeds (samples of the same prompt), or beam branches, and the merge
stage can pick the best by log-probability the way word count's merge picks the top-*k*. Pipelining
one sequence across tasks (a layer per task) would round-trip the filesystem per token and is not
worth it at this scale.

## Determinism, verified

The forward pass is f32 arithmetic in a fixed order: matrix–vector products, layer norm (`sqrt`
and division), GELU (`tanh` or the erf form), softmax (`exp`). AssemblyScript compiles `Math` to
WASM code, not host calls, so `exp`, `tanh`, and `sqrt` are bit-identical across engines; there is
no fused multiply-add unless asked for. Two nodes computing the same continuation produce the same
bytes — which is exactly what the redundancy toggle checks, and what makes recompute a
verification rather than a waste.

## The prototype, if built

1. **Train offline** (Python, on this laptop): a character-level GPT — vocabulary of ~90 bytes,
   context 128, 4 layers, 4 heads, width 128 (about 0.8 M parameters) — on `programs/wordcount/in/
   corpus.txt`, a few minutes on CPU for text that is recognisably Melville-shaped. Export weights
   as int8 with per-tensor scales, plus the vocabulary, into `/in/weights.bin`.
2. **The program** (`programs/tinygpt`, AssemblyScript): `plan` reads the prompts from the params
   and emits one task per prompt × seed with `(prompt, seed, tokens)` as the input; `run` loads the
   weights, runs the prompt through the model with a KV cache, samples *n* tokens with a
   counter-based PRNG seeded from the task's seed, and returns UTF-8 text. View `text`. A follow-up
   could chain "continue the best continuation".
3. **Measure on the machine**: tokens per second on a tab and on a core, the task's compute time
   against the deadline, redundancy on to prove identical bytes, and the stage's wall time for a
   dozen prompts.

Effort: about a day. Risks: AssemblyScript's lack of SIMD keeps it small; the 16 KB inline input
bounds the prompt; the weights read per task is the cost to watch.
