# WP0.3 — Core skeleton

**Milestone:** M0 · **Branch:** `wp/0.3-core` · **Merged:** 2026-09-01

## What

`packages/core` is the control plane as a pure function (design §6.1). This WP lands the ledger,
the event and effect vocabulary, and the M0 behaviors:

- **Ledger** (§6.2, the M0 subset): connections with their role and rate-limit bucket, node
  records (id, connection, host, kind, cores, joinedAt, lastSeen, visible, health, stats,
  in-flight placeholder), observer records, and meta (generation, event sequence, node counter,
  store base URL).
- **`apply(ledger, event, now) → effects`** for `connected`, `message`, `disconnected`, `tick`.
  Handles hello → welcome + `nodeJoined`; heartbeat → liveness and the throttled label from
  visibility; subscribe → paged snapshot; ping → pong with the current sequence; disconnect →
  `nodeLeft(closed)`.
- **Liveness sweep** (§6.4): silent nodes are gone after 4 s, closed with `declaredGone`, and
  announced as `nodeLeft(silent)`; silent observers are dropped after five missed pings;
  connections that never handshake are closed after 10 s.
- **Refusals** as close codes: invalid or foreign-generation messages, duplicate handshakes,
  messages before a handshake, the node cap (256), the observer cap (64), and the per-connection
  message rate (token bucket).
- **Interfaces** the process implements (§6.1): `Clock`, `Rng`, `Transport`, `Store`, plus a
  seeded PRNG for tests and the simulation.

## How

- `apply` mutates the ledger in place and returns the effects; it performs no I/O and takes time
  as a parameter, so the same function runs in the process, in a local dev server, and in tests
  on virtual time. The "pure" property that matters — no hidden inputs — holds.
- Decoding goes through the protocol codec with `expectGen` set to the ledger's generation, so
  the generation check is enforced for every message without per-handler code (§6.9).
- Events to observers are stamped with `++meta.seq` at broadcast time and fanned out as one
  `send` effect per observer; with no observers, nothing is stamped, so sequence numbers only
  advance for events someone could have seen.
- Rate limiting is a token bucket per connection refilled continuously at the role's rate, so a
  well-behaved node at one heartbeat per second is never limited and a flood is closed within a
  second.
- The one health label decided by node evidence alone, `throttled`, flips on the hidden flag and
  is announced once per change; fast/slow from compute statistics arrives with scheduling (WP1.2).

## Why

- **Pure function over a ledger** (§6.1) is what makes the churn simulation and the handover both
  possible: the simulation drives `apply` on virtual time; a handover serializes the ledger.
- **Refuse, never half-accept** (§8): every failure closes the connection with a code the client
  acts on; the ledger never holds a partially valid peer.
- **Sequence numbers from day one** so the observer gap-detection path (§7.5) has something to
  detect before task events exist.

## Evidence

- `bun test`: 41 tests across the workspace, 13 new here, including the acceptance case — a node
  that stops heartbeating is gone at 4 s with a `declaredGone` close and a `nodeLeft(silent)` to
  observers — plus caps, rate limit, handshake timeouts, visibility labels, and a fast-check
  property over 200 random activity sequences asserting map consistency, that nothing gone
  survives a tick, and that the sequence is monotonic.
- Coverage 100 % lines on `apply.ts` and `ledger.ts`; `mise run lint` clean.

## Dependencies introduced

| Package | Version | Why |
|---|---|---|
| `fast-check` | 4.9.0 | property-based tests over ledger transitions (design §12) |

## Drift

None.

## Open

None.
