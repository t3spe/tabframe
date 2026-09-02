# WP3.2 — Fleet v1

**Milestone:** M3 · **Branch:** `wp/3.2-fleet-v1` · **Packages:** `packages/fleet`,
`packages/infra`

## What

The rotation, driven end to end. `rotate` was a v0 that launched a control plane when none was
running and left a running one alone; it now performs the five steps of design §9.4 and leaves the
fleet in a state the next run can finish or roll back.

- **`HttpControlPlaneClient`** (`cp-client.ts`): calls a control plane's private port through the
  MicroVM proxy. Each call mints a one-minute token scoped to that MicroVM and port 8081, sends it
  as `X-aws-proxy-auth` with `X-aws-proxy-port`, and carries the fleet secret. Browser tokens are
  scoped to 8080 and cannot reach any of it. Fifteen-second timeout per call, `AbortController`.
- **The rotation.** Launch CP(g+1), naming the latest snapshot key so it boots adopted; wait for
  RUNNING; `/handover` on CP(g); `/adopt` on CP(g+1) with those bytes; flip the pointer;
  `/drain` on CP(g), five-second grace, terminate.
- **Failure paths, each a test.** A handover or adopt that fails does **not** fail the rotation:
  the successor already booted from a snapshot at most five seconds old, and every task is
  idempotent, so the cost is a little repeated work. A drain that fails still terminates the old
  control plane. A successor that never reaches RUNNING leaves the pointer untouched and nothing
  is terminated — the old control plane keeps serving.
- **Repair on the next run.** The pointer gains a `pending` record naming a successor that has
  been launched but not yet promoted, written before the handover and cleared at the flip. A run
  that dies in between leaves it behind; the next run finds it and either finishes the rotation
  (the successor is still serving: promote it, retire the old one) or forgets it (gone) or
  terminates it (the pointer already moved past it). No orphan MicroVM burns money for an hour.
- **The snapshot key** comes from the snapshot bucket's `latest.json.gz`, read by the rotate
  Lambda and passed in the run payload. The stack grants it the bucket read it already had and
  passes the bucket name in the environment.
- **The hourly rule** stays created-disabled, and `mise run up` enables it (D20). A deploy never
  starts rotating on its own.

## On reserved concurrency

The plan asked for reserved concurrency 1 on rotate, so two scheduled runs could never overlap.
The account's Lambda concurrency limit is 10 and reserving any of it is refused while the
unreserved pool must stay at 10 (recorded in the WP0.10 drift note). Overlap is therefore handled
by idempotency instead, which the tests cover: the `clientToken` is `tabframe-cp-g<generation>`, so
two runs racing to launch the same generation get one MicroVM; the pointer is the single source of
truth for who is active; `/handover` is idempotent and returns the same bytes; `/adopt` accepts a
repeat of the same ledger and refuses one from a later generation. A second run that starts mid
rotation either sees the pending record and finishes the same job, or sees the flip already done
and rotates again — which is a rotation, not a corruption.

## Tests

`packages/fleet/test/rotate.test.ts` gains a rotation suite with a fake control plane: the five
steps in order with the snapshot key in the payload and the pending record written then cleared;
a failed handover; a failed adopt and drain together; a successor that never boots; an interrupted
rotation finished by the next run; a pending successor that died, forgotten; a pending successor
the pointer already passed, terminated; a heal when nothing is serving; and off staying off
whatever is pending. `packages/fleet/test/cp-client.test.ts` covers the token scope, the headers,
the verbatim ledger body, the drain body, a non-2xx, an unusable handover body, and health.

Suite: 348 tests, 94 % of lines; lint and the three type-check projects green.

## Why this shape

- Telling the successor about the snapshot at boot makes the handover an optimization rather than
  a dependency. That is what turns "CP(g) is unreachable" from an outage into a slower rotation.
- The pending record lives in the pointer because the pointer is the one piece of state the fleet
  already owns, already writes atomically, and already reads first.
- Draining before terminating, with a grace period, means clients are told where to go rather than
  discovering it from a dropped socket — the difference between a two-second reconnect and a
  backoff.

## Left for later

- A real rotation on AWS with a render in flight, and the churn measurement, are WP3.5.
- The local two-process driver (`mise run dev:rotate`) and the Playwright rotation-mid-render test
  are WP3.4.
- Cloud cores, the fleet policy that keeps two alive, and the sleep policy are WP3.3.
