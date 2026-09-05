# Feasibility: a small transformer in WASM, predicting the next token on the cores

2026-09-03 · the question: can a Tabframe program be a small transformer that predicts the next
token, and is it worth building? It was, and it is: `programs/tinygpt` is the result.

## Short answer

Yes, for a *small* one: a character-level GPT of one to two million parameters fits the sandbox,
runs a token in a few milliseconds on a core, and gives identical bytes on a browser tab and a
MicroVM, so the redundancy toggle verifies it like any other task. What parallelises is the
prompts, not the sequence. GPT-2 small does not fit the sandbox's memory cap. Training is out of
scope: weights are an input file. The prototype took a day: a tiny model trained offline on the
Moby-Dick corpus the repository already carries, int8 weights shipped as a bundle input, the forward
pass written in AssemblyScript, and a stage of tasks generating continuations for a list of prompts
into the text view.

## What a program is allowed

| Constraint (design §5, §8.4) | Value | What it means for a transformer |
|---|---|---|
| Memory maximum a module may declare | 256 pages (**16 MiB**) is what the build flag and the editor declare; the control plane refuses a module above 1024 pages (64 MiB) | weights, activations, and the KV cache all live here; f32 weights of *N* parameters need 4 *N* bytes |
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

## The prototype, built

`programs/tinygpt` is the third program the image ships. Measured on 2026-09-03:

| | |
|---|---|
| Model | character-level GPT, 97-symbol byte vocabulary, context 128, 4 layers × 4 heads × width 128, **822 144 parameters** |
| Training | `programs/tinygpt/train/train.py`, PyTorch on this laptop's CPU, 3 000 steps of 32 × 128 tokens on the Moby-Dick corpus, about 12 minutes; validation loss 1.47 nats per byte |
| Weights | `programs/tinygpt/in/weights.bin`, **822 685 bytes**: int8 with one f32 scale per tensor; dequantised to f32 in the module (3.3 MB), well inside the 16 MB cap with the KV cache (0.5 MB) |
| Module | `programs/tinygpt/dist/program.wasm`, 19.6 KB of AssemblyScript: the whole forward pass — layer norm, attention with a KV cache, GELU, tied output embedding, greedy decoding |
| Speed | **4.0 ms per token** under Bun's WebAssembly (4 prompts × 24 tokens in 387 ms, weights loaded once per task) — a 96-token continuation is under half a second here, a few seconds on a core |
| Correctness | the module's greedy continuations equal the training script's reference, computed by PyTorch with the same dequantised weights, **token for token on 96 of 96** — the f32 sums in a different order never flipped a choice |
| Determinism | two runs give the same bytes; on the machine, redundancy on verifies the same across tabs and cores |
| Shape | stage 0: one task per prompt (`prompts`, `|`-separated, `tokens` per continuation); stage 1: one task joins the continuations into the text the dashboard shows |

What it says, greedily, after twelve minutes of training: *"Call me Ishmael the ship of the ship
of"* — Melville-shaped, repetitive the way greedy decoding of a small model is. Sampling with a
seed from the params is the obvious next step and stays deterministic.

## What was planned, and what differed

The plan was a character-level GPT of about 0.8 M parameters trained offline on the word-count corpus,
int8 weights with per-tensor scales as a bundle input, one task per prompt, and a measurement pass on
the machine — and that is what was built, with two differences. Decoding is greedy rather than
sampled with a counter-based PRNG (sampling with a seed from the params stays deterministic and is
the obvious next step), and the vocabulary is the corpus's 97 symbols rather than the ~90 guessed.
The risks named in advance held: AssemblyScript's lack of SIMD keeps the model small, the 16 KB
inline input bounds the prompt, and the weights read per task is the cost to watch.
