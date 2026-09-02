# WP1.4 — Sandbox

**Milestone:** M1 · **Branch:** `wp/1.4-sandbox` · **Package:** `packages/sandbox`

## What

The runtime-agnostic glue that runs one task of a Tabframe program in a fresh WebAssembly instance
(design §4.2), with the module contract and the filesystem semantics of §5.3–§5.5, and the two
adapters that put it on a thread:

- **Validation** (`validateModuleBytes`, `validateCompiled`): size under `LIMITS.maxModuleBytes`,
  well-formedness, a declared memory maximum at or under `limits.memoryPagesMax` (read straight
  from the binary's memory section, since the JS API does not expose it), no shared or 64-bit
  memory, the import allowlist — only `tf.{stat,read,write,list,log}` and `env.abort`, all
  functions — and the required exports `memory`, `alloc`, `run`, `plan`. A rejection names the
  offending import or export.
- **`runTask(module, request)`**: a fresh instance per call, the five `tf` imports bound to a
  `FsView` for this task alone, input copied in through `alloc`, the entry's returned pair
  `{outPtr, outLen}` copied out under `maxOutputBytes`; traps, aborts (with the AssemblyScript
  message when one is given), link errors, and out-of-bounds pointers all become
  `{ok: false, error}` with the log so far.
- **`FsView`**: `stat`/`read`/`list` resolve against the stage manifest first and the task's own
  write buffer second; `write` replaces whole files under the path grammar and the file and byte
  caps; `log` appends under the log cap and marks truncation. Bytes for a hash come from a
  synchronous `BlobReader`; `CachingBlobReader` fetches each blob once per node and serves every
  later range from memory.
- **Node adapter**: `createNodeSandboxHost({fetchBlob})` spawns a `worker_threads` worker running
  `node-worker.ts`; the worker's reader blocks on a SharedArrayBuffer with `Atomics.wait` while the
  host thread fetches asynchronously and drops the bytes into the buffer, chunked through a
  fixed-size region; a deadline terminates the worker outright and the next task gets a fresh one.
- **Web adapter**: `web-worker.ts` is the dedicated-worker entry with a synchronous
  XMLHttpRequest reader against `${storeBase}/${hash}` (Range header for partial reads);
  `createWebSandboxHost(workerUrl, storeBase)` is the dependency-free host side the browser
  orchestrator will use, built on the same generic `createSandboxHost` as the Node adapter.

## How

- `createSandboxHost(spawn, onOther)` in `host.ts` is the one host: lazy spawn, one worker reused
  across tasks, tasks serialized, a deadline timer per task that terminates and drops the worker,
  late error events from a replaced worker ignored, `dispose()` final. The Node and web adapters
  only differ in how they wrap their worker primitive and where bytes come from.
- The bridge protocol (`bridge.ts`): a 16-byte header (`status`, `length`) and a data region.
  The worker stores `waiting`, posts `{type: "blob", hash, offset, len}`, and waits; the host
  fetches, fills the region, stores `length` and `ready` (or `notFound`), and notifies. Reads
  larger than the region loop in chunks; a short chunk means end of file.
- `readMemoryLimits` is a forty-line reader of the wasm binary's memory section (LEB128 limits
  with the shared and memory64 flags), so the maximum is checked before any compile.
- AssemblyScript strings passed to `abort` are UTF-16LE with their byte length four bytes before
  the data; the glue decodes them so a program's `abort("reason")` reaches the dashboard.
- Fixtures are AssemblyScript sources under `test/assembly/`, compiled at test time by the pinned
  compiler through its JS API, in memory, cached per process. They cover echo, a global counter,
  an infinite loop, abort and unreachable, a clock read (forbidden import), a module without
  `plan`, and a program that exercises all five imports in nine modes.

## Why

- **Fresh instance per task** (design §4.2, D12): the counter fixture proves that state cannot
  leak between tasks of the same program, which is what keeps results a pure function of input
  plus filesystem.
- **Validation before instantiation** (design §5.5): a forbidden import is refused by name before
  any code runs; a missing memory maximum is refused because an unbounded module could grow to
  the host's limit.
- **Synchronous readers** (design §4.2, verified in preflight): imports cannot await, so bytes
  arrive through a synchronous request in browsers and an Atomics handshake under Node. The
  caching layer makes the cost one fetch per blob per node.
- **Termination as the only kill** (design §4.2): a spinning loop cannot be interrupted from
  inside WebAssembly; the host ends the worker and replaces it, and the tests show the second
  task after a kill runs normally.

## Evidence

- `bun test packages/sandbox`: 33 tests. Validation: pass, forbidden import named, allowed
  imports accepted, missing `plan`, missing and oversized memory maximum, size cap, garbage,
  memory-section reader on real and junk bytes. `runTask`: echo round trip, plan returning a
  decodable done spec, fresh instance per task, abort message and trap, output cap, missing
  entry. Through a real program: stat/read/list/write/log, file and byte caps, log truncation,
  unknown and bad paths, bad arguments, list's bytes-needed answer, offset reads, own writes
  shadowing, determinism. Host: serialization and worker reuse, deadline kill and replacement,
  crash and replacement, other messages routed, dispose settling, the browser worker wrapper.
  Node adapter under a real `node` child: reads flow through the bridge in 8-byte chunks with
  one fetch per blob, a spinning loop is killed at the deadline on both entry points and the
  host recovers, and a normal task runs after a kill.
- Full workspace: 194 tests pass; all three `tsc` projects clean; Biome clean.
- Coverage: the host, glue, validation, filesystem, and types are measured at 96–100 % lines;
  the worker entries and the Node host (which run in worker threads or a browser) are excluded
  from the gate and exercised by the spawned-Node test and, from WP2.6, Playwright.

## Dependencies introduced

| Package | Version | Why |
|---|---|---|
| `assemblyscript` (root, dev) | 0.28.20 | compiles the test fixtures at test time; the same pinned compiler the SDK and the in-page editor use |

## Compiler flags the SDK must use

`--runtime stub` (or `minimal`), `--maximumMemory <pages>` so the memory section declares a
maximum (64 KiB pages; 256 = 16 MiB), and either the default `env.abort` import (allowed, and the
message reaches the error) or `--use abort=` to turn aborts into plain traps. No `--importMemory`,
no `--sharedMemory`, no `--exportRuntime` needed. A program that touches `Date`, `Math.random`
(`env.seed`), or any WASI import fails validation.

## Drift

Details design §5.3 left open, pinned here for the SDK worker and the design record:

- **Return codes:** `stat` → size or -1; `read` → bytes copied (0 at or past end of file), -1 not
  found (a missing manifest entry or a blob the store cannot deliver), -2 bad arguments (negative
  offset or length, or a destination outside memory); `write` → 0, -2 for a path outside the
  grammar, -3 when the file-count or byte cap would be exceeded; `list` → the byte length of the
  listing, copied only when it fits in the buffer, so a result larger than the buffer means "call
  again with this much room"; `log` has no return value and truncates silently.
- **List format:** paths under the prefix (own writes included), sorted, joined by `\n`, no
  trailing newline; string prefix match, so `/in/` lists a directory and `/in/a` also matches
  `/in/abc`.
- **Write semantics:** a whole-file replace; writing the same path twice keeps the last; a task's
  own writes shadow the manifest for its later reads and stats.
- **The output pair:** `run` and `plan` return a pointer to eight bytes, `u32 outPtr` then
  `u32 outLen`, little-endian; `alloc(0)` is never called (empty inputs skip the copy).
- **Strings:** UTF-8 at `(ptr, len)` for every path, prefix, and log message.

## Open

- The web worker entry is bundled and driven from a browser in WP2.6; until then its glue is
  covered by the shared `runTask` tests and the host by the fake-worker tests.
- Bun cannot measure coverage inside worker threads; if that ever matters, `NODE_V8_COVERAGE`
  in the spawned driver would close the gap.
