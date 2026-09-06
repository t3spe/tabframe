# @tabframe/sdk-as

The AssemblyScript SDK for Tabframe programs, and the tooling around programs: the build script,
the goldens script, a program-loading module, and a test host that runs programs through the same
sandbox the machine uses.

A program is one WebAssembly module with two entry points and a manifest (design §5). It sees the
world only through a per-execution filesystem, has no clock, no randomness, and no network, and
its API has no failure type: tasks complete, or the execution fails with a program fault.

## Writing a program

```ts
import { readRunInput, readPlanInput, stage, done, emit, ByteWriter, ByteReader, Params, fs, log }
  from "@tabframe/sdk-as/assembly/index";
export { alloc } from "@tabframe/sdk-as/assembly/index";

export function plan(ptr: usize, len: i32): usize {
  const input = readPlanInput(ptr, len);          // stage, params, hints
  if (input.stage == 0) {
    const s = stage("map").canvas(2048, 1280);
    for (let i = 0; i < 640; i++) s.taskAt(inputBytes(i), x(i), y(i), 64, 64);   // or s.task(bytes)
    return emit(s.toBytes());
  }
  const next = new Params();                      // optional follow-up params
  next.setI32("preset", input.params.getI32("preset", 0) + 1);
  return emit(done(next));                        // or done(null)
}

export function run(ptr: usize, len: i32): usize {
  const t = readRunInput(ptr, len);               // stage, taskIndex, taskCount, input bytes
  const r = new ByteReader(t.input);
  // ... compute ...
  return emit(outputBytes);                       // a Uint8Array
}
```

- **Params** are a flat table of key → JSON text. `getString`, `getI32`, `getF64`, `getBool` take a
  fallback; `getI32In(key, fallback, lo, hi)` clamps; `raw(key)` gives the JSON text (arrays and
  objects come through untouched). Setters write JSON. Keys are sorted when written, so equal tables
  are equal bytes.
- **Stage** builds what `plan` returns: a name, an optional canvas (for the `tiles` view), and tasks
  with inline input (≤ 16 KB each, ≤ 4096 tasks, ≤ 1 MB spec) with or without a placement rect.
- **fs** is the execution's filesystem: `fs.stat(path)` (size or −1), `fs.read(path)` and
  `fs.readRange(path, offset, len)` (null when absent), `fs.readOrAbort(path)` (a missing file is a
  program fault), `fs.outputs(stage)` (every task output of an earlier stage, in index order),
  `fs.write(path, bytes)` (replaces the whole file; visible to the next stage once the result is
  accepted), `fs.list(prefix)`. `fs.readRc` and `fs.writeRc` return the sandbox's return codes
  (`RC`: not found, bad arguments, cap exceeded) where the boolean forms flatten them. Results land
  at `/out/<stage>/<task>` automatically; bundle inputs are under `/in/`. Reads cost a round trip
  each, so read whole files or large ranges.
- **log(text)** appends to the task's log, shown in the dashboard's task detail and capped.
- **ByteWriter / ByteReader** are for your own compact task inputs (u8/u32/i32/f32/f64, blobs,
  strings), little-endian.

- **bars()** builds the payload a `bars` program's final task returns:
  `bars().bar("the", 14529).bar("of", 6620).toBytes()`. Values must be finite (NaN payload bits
  differ between engines); the builder aborts otherwise. The dashboard decodes it with
  `decodeBars` from `@tabframe/protocol`.

Multi-stage programs read the previous stage's results as files: `fs.outputs(0)` returns every task
output of stage 0 in order, `fs.readRange` reads a slice of one. See `programs/wordcount` for a
three-stage map/reduce/merge that does exactly this.

**Allowed imports:** `tf.stat`, `tf.read`, `tf.write`, `tf.list`, `tf.log`, and `env.abort`.
Anything else is rejected at upload: `Date.now`, `Math.random` (which needs `env.seed`), `console`,
WASI. AssemblyScript's `Math` compiles to WebAssembly and is deterministic across browsers and
machines; never write NaN into an output, because NaN payload bits are not.

**How long a task may run.** The control plane gives each task a deadline: the floor (two seconds)
or three times the median of the stage's completed tasks, whichever is longer. A task that is not
finished by then is released by its node and given to another with a doubled deadline, three
doublings at most (so up to sixteen seconds at the floor); a task released six times fails the
execution as a program fault. Keep tasks short and many rather than few and long; a few hundred
milliseconds each is the sweet spot.

## Compiling

Programs depend on `@tabframe/sdk-as` (workspace) and import it by the subpath above; asc resolves
it through the program's `node_modules`:

```
asc programs/<name>/assembly/index.ts --outFile programs/<name>/dist/program.wasm \
    --path programs/<name>/node_modules --baseDir . -O3 --runtime stub --noAssert --maximumMemory 256
```

`mise run build:programs` does this for every `programs/*/assembly/index.ts`. The flags matter:

- `--runtime stub` (or `minimal`): a bump allocator with no collector. Every task runs in a fresh
  instance, so nothing leaks between tasks and nothing needs freeing.
- `--maximumMemory <pages>`: the sandbox requires a declared memory maximum (64 KiB pages; 256 is
  16 MiB, the reference value) and rejects modules without one or above its cap.
- `-O3 --noAssert`: speed; assertions are development aids, not runtime checks.


## Byte formats

The SDK mirrors the protocol's ABI modules byte for byte (`packages/protocol/src/abi-bytes.ts`,
`abi-inputs.ts`, `abi-spec.ts`, `abi-bars.ts`); those files are the contract. Magics
`TFRN` (run input), `TFPL` (plan input), `TFSS` (stage spec), `TFBR` (bars payload); little-endian;
`str` = u32 length + UTF-8; `table` = u32 count + (str key, str JSON value) with keys sorted. Entry
points return a pointer to an 8-byte `{outPtr: u32, outLen: u32}` pair, which `emit` produces.

## Tooling

- `scripts/build-programs.ts`: `mise run build:programs`.
- `scripts/goldens.ts`: `mise run goldens` writes `programs/<name>/goldens.json` from a single-node
  run (params from the manifest): per-tile hashes for `tiles` programs, every stage's hashes plus
  the decoded final payload for staged ones (`--program wordcount`); `--check` compares instead of
  writing; `--all --sample 16` times every Mandelbrot preset; `--preset N` times one.
- `scripts/programs.ts` (`@tabframe/sdk-as/programs`): where a program lives, its manifest, inputs,
  goldens, and a compiled module that is rebuilt only when its sources are newer.
- `scripts/host.ts`: runs a module under Node with in-memory files through the sandbox's own
  `runTask`, and `runStaged` to run a whole execution stage by stage the way the control plane
  would; used by the goldens script and the tests. `flags.ts` holds the compiler flags the build,
  the tests, and the page share.
- `scripts/corpus.ts`: `mise run corpus` fetches and normalizes the word-count corpus into
  `programs/wordcount/in/corpus.txt` (committed; the script is for reproducibility).
