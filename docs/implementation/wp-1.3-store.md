# WP1.3 — Store

**Milestone:** M1 · **Branch:** `wp/1.3-store` · **Merged:** 2026-09-02

## What

`packages/store`, the content-addressed blob store of design §7.1 in both shapes plus the one
client flow everyone uses:

- **`StoreDriver`** — what the control plane needs: a URL for a hash, presigned uploads, exists,
  get, and the control plane's own put (manifests, seeded bundles).
- **`LocalStore`** — bytes in memory served by the control-plane process itself; presign returns
  URLs to its own `PUT /blob/<hash>` route, which verifies the hash on receipt. Moved here from
  the control plane so both drivers sit behind one interface.
- **`S3Store`** — keys are `blob/<hash>` in the blob bucket behind CloudFront. Presign is a
  PutObject presigned for five minutes with `ChecksumSHA256` pinned to the key's hash, an
  immutable cache-control header, and the content length; S3 refuses bytes that do not hash to the
  key. `exists` is a HeadObject; blobs the store already holds get no URL. The headers a client
  must send are read back from the URL's `X-Amz-SignedHeaders`, with the checksum pin always
  included.
- **`StoreClient`** — hash locally with Web Crypto, ask for presigns over the socket (a
  `PresignRequester` the node and the page implement), PUT straight to the store with the given
  headers, skip blobs the store already has, and read by hash from the CDN with Range support.
- The control plane executes the scheduler's store effects: `presign` answers the socket with
  `presigned`, `fetchBlob` and `putBlob` round-trip through the driver into `blobFetched` and
  `blobStored` events. Image mode selects the S3 driver from the image environment's bucket name;
  local mode keeps serving blobs itself.

## How

- One presign round trip per batch: the client deduplicates by hash before asking, so a task's
  output, its written files, and its log cost one socket message.
- `signedHeaders` derives the header set from the signature rather than assuming it, because
  which headers a given SDK version hoists into the query string varies; the checksum header is
  sent regardless, since it is the point of the exercise.
- The driver is chosen at process start; nothing else in the control plane knows which one it is.

## Why

- **Bytes never transit the control plane** (D9): the client uploads straight to S3 and reads
  from CloudFront; the control plane only ever moves hashes and small manifests.
- **The store vouches for hashes** (D8): with the checksum pinned in the presigned request, a node
  cannot file bytes under a name they do not hash to, so the ledger can trust a reported hash.
- **One client flow** (design §7.1): the local driver's presign returns URLs to itself, so nodes
  and pages run the same code against a laptop and against AWS.

## Evidence

- `bun test`: 9 store tests — SHA-256 and the hex/base64 conversions S3 expects, the local
  driver's put/presign/verify/get, the S3 driver with a mocked client (key layout, 404 → false,
  presigned URL with the pinned checksum, existing blobs skipped, get, put with the pin and
  cache-control, no re-put of existing bytes, non-404 errors propagate), signed-header selection,
  and the client (dedup, one presign per batch, PUT headers, skips, Range reads, 404 → null,
  failures throw). The control-plane process test still covers the local PUT/GET routes through
  the moved driver. 189 tests across the workspace; `mise run lint` clean.

## Dependencies introduced

| Package | Version | Why |
|---|---|---|
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` | 3.1124.0 | the S3 driver and presigning |
| `aws-sdk-client-mock` (dev, already used by fleet) | 4.1.0 | driver tests without an account |

## Drift

None. Which headers the presigned PUT must carry is verified against the real bucket in WP1.10.

## Open

- The node orchestrator adopts `StoreClient` for uploads in WP1.6; the page in WP2.3.
