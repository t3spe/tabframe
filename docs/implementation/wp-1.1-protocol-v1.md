# WP1.1 — Protocol v1

**Milestone:** M1 · **Branch:** `wp/1.1-protocol-v1` · **Merged:** 2026-09-02

## What

The wire grows from the M0 handshake to the full vocabulary of design §8 and the program ABI's byte
formats of §5.3, so the scheduler (WP1.2), the sandbox (WP1.4), and the SDK (WP1.5) can be built
against one definition.

- **Node socket:** `assign` (task id, attempt, execution, program hash, kind, stage, index, count,
  inline input as base64 under the 16 KB cap, filesystem root, deadline, per-task limits),
  `result` (output hash, write list, log by hash or inline, compute time — or an error message;
  exactly one of the two), `presign` / `presigned` (D18), `cancel`, `command`.
- **Observer socket:** every control (`killHalf`, `freezeHalf`, `throttleHalf`, `resumeAll`,
  `restart`, `skip`, `killExecution`, `launch` with bundle, params, and inherit, `runFollowUp`,
  `setRedundancy`), `presign` for bundle uploads, snapshots that carry the cluster on page 0 and
  task rows on every page, and the complete event set: execution, stage, task, control, program,
  rotation, and sleep events, each sequence-numbered.
- **Shared vocabulary:** task and execution views, counters, queue entries, the machine view,
  per-task limits, the program manifest, the filesystem manifest, and the path grammar
  (absolute, simple segments, no `.` or `..`).
- **The ABI byte formats** in `abi.ts`: what `run` receives, what `plan` receives, and what `plan`
  returns, with encoders and decoders on this side. Params and hints travel as a sorted table of
  key → JSON text, so a program never needs a JSON parser. The stage-spec decoder enforces the
  structural caps (4096 tasks, 1 MB, 16 KB inline input, placement and canvas sanity).

## How

- Formats are binary, little-endian, and start with a magic and a version. The writer grows a
  buffer; the reader refuses truncation and trailing bytes. Every decode failure is an `AbiError`
  with a reason the dashboard can show as a program fault.
- `result` is one schema with a refinement (exactly one of `output` or `error`) rather than two
  members with the same tag, which keeps the direction unions discriminated on `t`.
- Snapshot pages after the first carry only tasks; the first also carries nodes, the execution,
  the queue, and the machine view, so a 640-task frame is three messages under the size cap.
- The core and the dashboard reducer gained explicit default branches for the message types they
  do not act on yet; the M0 behavior is unchanged.

## Why

- **One definition** (design §8.1): both ends and both parallel workers import the same schemas
  and the same byte layouts, which is the only way an AssemblyScript SDK and a TypeScript
  decoder stay in agreement.
- **A flat parameter table** keeps the ABI free of any JSON dependency inside programs and makes
  plan inputs deterministic regardless of key order (D12).
- **Caps in the decoder** (design §5.2) so a hostile planner cannot make the control plane
  materialize a million tasks.

## Evidence

- `bun test`: 161 tests; new coverage for every v1 message and control, result's exactly-one rule,
  path grammar rejections, the inline input cap, snapshot pages, all events, manifests with
  defaults, ABI round trips, magic and version and truncation errors, every structural cap, and a
  fast-check property over random stage specs (150 runs).
- `mise run lint` clean across the three TypeScript projects.

## Dependencies introduced

`fast-check` moved to the root dev dependencies (it is used by two packages now).

## Drift

None.

## Open

None.
