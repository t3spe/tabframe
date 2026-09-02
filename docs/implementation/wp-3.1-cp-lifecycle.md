# WP3.1 — Control-plane lifecycle for real

**Milestone:** M3 · **Branch:** `wp/3.1-cp-lifecycle` · **Packages:** `packages/core`,
`packages/control-plane`

## What

The control plane's half of a rotation (design §9.4). The fleet drives the order; this work package
gives the process the three routes it drives with, and the core the two operations behind them.

- **Phases.** A ledger now carries `meta.phase`: `active`, `handing-over`, or `drained`. Only an
  active control plane fills nodes with work, and only an active one accepts socket upgrades — a
  handed-over process stops assigning the moment its ledger leaves, and its would-be clients get a
  503 and go back to the session function, which points them at the successor. Adopting a ledger
  always stamps it `active`, whatever the source was doing.
- **`POST /handover`** (private port): `beginHandover` marks the phase, serializes the ledger, and
  returns it with the generation. Idempotent — a second call returns the same bytes, which is what
  makes a retried rotation safe. A snapshot is forced at the same moment, so the S3 fallback path
  is never staler than the handover.
- **`POST /adopt`**: deserializes the ledger, refuses one from a *later* generation (that would be
  a rollback), and otherwise adopts it under this process's own generation — marking every node
  gone, releasing their work, clearing connections and observers. Adopting twice with the same
  ledger is accepted and harmless, which is the property a retried rotation needs. Seeding is
  skipped when the adopted ledger already has programs.
- **`POST /drain`**: broadcasts `controlPlaneRotating` to observers, then closes every client with
  close code 4005 and a JSON reason carrying `{gen, next, reconnectAfterMs}`. Each client's delay
  is drawn uniformly from a window of 30 ms per connected client with a two-second floor (§8.4),
  so 300 clients spread their reconnects over about nine seconds — about 33 session calls a
  second, under the endpoint's measured 50 per second and the account's concurrency of 10. The
  reason stays inside the WebSocket's 123-byte limit, which a test asserts.
- **The fleet secret.** `/handover`, `/adopt`, `/drain`, `/snapshot`, and `/diag` require the
  `x-tabframe-fleet-secret` header to match the secret from the run payload, compared in constant
  time. In local mode there is no payload and no secret, so they are open; the private port is not
  routable from a browser in either case, and locally it binds to the loopback address. `/health`
  stays open: it carries counts and uptime, and the operator scripts and the deploy runbooks poll
  it.

## Tests

- `packages/core/src/handover.test.ts`: handover stops assignment for good and produces a ledger a
  successor deserializes, adopts, and finds free of open attempts, with its programs, executions,
  and tasks intact; a second handover returns identical bytes; drain announces the rotation, closes
  every client with the right code, a reason under 123 bytes and a delay inside the window; the
  window formula; and, over forty clients, delays that actually spread rather than landing
  together.
- `packages/control-plane/src/rotation.test.ts`: two real control-plane processes in image mode
  with an injected store. A node socket joins the first, the first hands over, refuses new sockets,
  the second adopts (programs intact, nodes gone), a retry adopts again, a newer ledger is refused,
  the first drains and the node's close carries code 4005 with the generation, the successor, and a
  delay. Plus: every fleet route answers 403 without the secret and 403 with a wrong one, `/health`
  stays open, `/snapshot` is gated, and an unreadable ledger is a 400.

Suite: 334 tests, 94 % of lines; lint and the three type-check projects green.

## Why this shape

- Phases live in the ledger rather than beside it, so a snapshot taken mid-rotation says what it
  was; deserialization resets to `active` because a ledger that is being read is being taken over.
- Refusing upgrades rather than accepting-and-closing keeps the handed-over process from ever
  minting a node id it will not honour.
- The jitter window is a function of the client count, computed at drain time, because that is the
  only moment the control plane knows how many clients are about to come back at once.

## Left for later

- The fleet's side — launch the successor, call the three routes in order, flip the pointer,
  terminate after a grace period, and repair a rotation that died halfway — is WP3.2.
- `/resume` revalidation and the core role in the image are WP3.3.
