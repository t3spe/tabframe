# M1 verification

`mise run verify:m1` against the deployed machine in the Tabframe account (us-west-2), generation 3,
on 2026-09-02. It opens three browser tabs on the real page (six nodes, two per tab), watches the
control plane as an observer through the MicroVM proxy, launches the golden Mandelbrot frame,
kills half the cluster mid-frame, and compares every settled tile to the goldens the SDK suite
pins. Account ids and tokens never reach the script's output.

| Check | Result | Pass |
|---|---|---|
| Session | on, generation 3, endpoint assigned, store base under the web origin | yes |
| Seeded programs | mandelbrot (tiles), seeded by the control plane from the image | yes |
| Tab nodes joined | 6 of 6 (3 tabs × 2 nodes) after 3.9 s | yes |
| Default loop | the machine was already rendering when the runbook arrived | — |
| Launch accepted | human launch went ahead of the automatic continuations | yes |
| Kill half | 3 victims at 128 tiles; 3 nodeLeft and 6 taskReassigned within 6 s | yes |
| Frame complete | 640 tiles in 69 s, **640 of 640 match the goldens tile for tile**, 0 task failures, follow-up `{preset: 1}` | yes |
| Scheduler activity | 2 speculative twins, 6 reassignments after the kill | — |
| Tab upload reads back | 200 from CloudFront, 16384 bytes, hash matches, cache hit | yes |
| S3 snapshots | `latest.json.gz` 4 s old under the current generation prefix | yes |
| Back to the default loop | the machine resumed its own loop after the human frame | yes |

Nine checks passed, none failed, two informational.

## What it means for the design

- **Browser tabs are enough.** Every tile in that frame was computed inside a Web Worker in a
  browser tab, uploaded straight to S3 with a presigned PUT, and named to the control plane only
  by hash. Cloud cores (M3) are extra capacity, not a requirement.
- **Bit-for-bit determinism holds across machines.** The goldens were produced by Node on the
  development machine; the tiles came from Chromium on the same laptop talking to a MicroVM in
  us-west-2. All 640 hashes match, so the WebAssembly sandbox is reproducible across hosts and
  runtimes, which is what makes duplicate results a correctness check rather than noise.
- **Killing half the cluster is invisible in the output.** Six nodes, three killed at tile 128:
  the reassignments show up as events and the frame still completes with the same hashes. That is
  at-least-once assignment plus single-assignment memoized results doing their job.
- **The checksum pin is real, and it has to be a signed header.** See the drift note below.

## Notes

- **The presign bug this run found.** Before this deploy, every tab upload failed with 403 —
  *"There were headers present in the request which were not signed: x-amz-checksum-sha256"*. The
  signer hoists the checksum into the query string by default, so the client could not send it as
  a header. Sending only the signed headers made the PUT succeed, but then a tampered body was
  **also** accepted: with the checksum in the query, S3 ignores it. Presigning with
  `signableHeaders` and `unhoistableHeaders` for `x-amz-checksum-sha256` fixed both: correct bytes
  return 200, tampered bytes return 400 `BadDigest`. Verified directly against the real bucket,
  and pinned by a unit test that asserts the checksum appears in `X-Amz-SignedHeaders` and not in
  the query string.
- **A failing program used to spin the machine.** While uploads were failing, the default loop
  relaunched about ten executions a second, each failing at its first task. The loop now backs off
  after a failure — five seconds, doubling to five minutes, reset by a success — and ended
  executions beyond the most recent 32 are pruned with their tasks on every tick, so the ledger
  and its snapshots stay bounded.
- **Compute time is whole milliseconds.** The sandbox measures with a high-resolution clock; the
  wire's `millis` is an integer. Unrounded values were closing sockets with code 4000 until the
  node rounded them.
- **The node message rate limit was too low.** Twenty messages a second could not cover a presign
  and a result per tile at a few milliseconds a tile; honest nodes were being disconnected. It is
  1000 now.
- Cloud cores are not part of M1: the fleet still launches only the control plane. The 8-hour
  MicroVM ceiling and the hourly rotation are exercised in M3.
