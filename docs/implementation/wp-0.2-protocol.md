# WP0.2 — Protocol skeleton

**Milestone:** M0 · **Branch:** `wp/0.2-protocol` · **Merged:** 2026-09-01

## What

`packages/protocol` is the single source of truth for the wire (design §8). This WP lands the
foundation and the M0 subset of messages:

- The envelope every message carries: `t` (type), `v` (protocol version, currently 1), `gen`
  (control-plane generation).
- Node socket: `hello`, `heartbeat` (node → control plane) and `welcome` (control plane → node).
- Observer socket: `subscribe`, `ping` (observer → control plane) and `snapshot` (nodes only for now,
  paged), `pong` (carrying the sequence number), `error`, and the node events `nodeJoined`,
  `nodeLeft`, `nodeHealth`.
- Shared vocabulary: node and host ids, SHA-256 hash pattern, node kind (`tab` | `core`), health
  labels, the `NodeView` observers see.
- Close codes for every way a connection is refused (design §8.4), including `rotatingReconnect`
  with its jittered delay payload.
- Limits: message size cap, inline input cap, snapshot page size, node and observer caps,
  heartbeat and liveness timings, rate limits, reconnect window.
- The codec: `encode` produces canonical JSON and asserts the size cap; `decode` validates a text
  frame against a schema and maps every failure to the close code the receiver should hang up with.

## How

- Schemas are zod 4 objects composed from shared field schemas; directions are discriminated unions
  on `t`, so a message sent the wrong way fails validation.
- `decode` checks in order: text frame, size, JSON, object, protocol version, generation (only when
  the caller passes `expectGen`), then the schema. The first failure wins and names the field.
- Canonical JSON sorts keys recursively and drops `undefined`, so identical logic yields identical
  bytes wherever a message or manifest is hashed. `byteLength` counts UTF-8 bytes with
  `TextEncoder`, which behaves identically in browsers and Node.
- Types are inferred from the schemas (`z.infer`), so there is exactly one definition per message.

## Why

- **Both ends validate every inbound message** (design §8.1); a schema package that both import is
  the only way to keep them agreeing.
- **Generation on every message** (design §6.9) is enforced at the codec, not per handler, so a
  control plane cannot forget to check it.
- **Close codes as the failure vocabulary**: a rejected message is never half-accepted; the
  connection is closed with a code the client can act on (reload on version mismatch, reconnect
  through the session function on rotation).
- The larger message set (`assign`, `result`, controls, task events) arrives in WP1.1 on the same
  foundation.

## Evidence

- `bun test`: round trips for every M0 message and for each direction's union; rejections for
  binary frames, oversized frames, non-JSON, non-objects, version mismatch, foreign generation,
  schema violations (with the field named), unknown types, and wrong direction; encode refuses
  frames over the cap; canonical JSON stability and UTF-8 byte counting.
- `mise run lint` clean; `tsc --noEmit` clean across the workspace.

## Dependencies introduced

| Package | Version | Why |
|---|---|---|
| `zod` | 4.5.4 | schema validation and inferred types, the one definition per message |

## Drift

None.

## Open

None.
