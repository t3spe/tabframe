# WP3.3 — Cloud cores

**Milestone:** M3 · **Branch:** `wp/3.3-cloud-cores` · **Packages:** `packages/core`,
`packages/control-plane`, `packages/fleet` (exports)

## What

The machine can now grow its own cores, and knows when to stop.

- **The policy lives in the core** (`packages/core/src/fleet.ts`), which is pure: `fleetTick` runs
  on every tick and emits two new effects, `launchCore` and `terminateCore`. While awake it keeps
  two cores, launching one per second (the account's RunMicrovm rate), and retires any core within
  half an hour of its four-hour ceiling so its replacement is up before it goes. The process is
  what calls AWS.
- **Cores are in the ledger.** A `CoreRecord` per MicroVM id, with the node it connected as. They
  are serialized with the ledger, so a handover carries them and the successor inherits its cores
  rather than launching two more; adopting clears the node links, because those sockets belonged
  to the previous generation.
- **The link between a core and its node** is the host id: a cloud core calls itself
  `core-<microvmId>`, and `microvmIdOfHost` reads it back. No extra message, and it survives a
  reconnect.
- **The sleep policy** (§6.8): asleep after ten minutes with no observer, or sixty minutes with a
  dashboard open but untouched — a tab left open overnight. Sleeping terminates the cores, pauses
  automatic continuation, and says `machineSleeping` once. Any interaction (a control, a fresh
  visitor) wakes it, and the fleet comes back on the next tick. The machine view now reports the
  real state instead of a hard-coded "awake".
- **The process side** (`packages/control-plane/src/cores.ts`): a core is launched with the core
  role, no ingress connector (a core dials out; nothing dials in), no idle policy, a four-hour
  ceiling, and a unique client token per launch. `packages/control-plane/src/core-node.ts` starts
  the **same orchestrator a browser tab runs** when the run payload says `role: core`, so a cloud
  core and a tab are the same code down to the sandbox.
- **A laptop launches nothing.** `config.cloudCores` is false unless the process is the MicroVM
  image with an image ARN, a core role, and a session URL. Local runs and the simulation still
  wake and sleep; they simply have no fleet.

## Tests

- `packages/core/src/fleet.test.ts`, thirteen cases: two cores kept, one launch a second, records
  in the ledger; a core linked at hello and unlinked when its node goes, without forgetting the
  MicroVM; a dead core replaced; a core at its ceiling retired and replaced; a laptop launching
  nothing; the host-id rule; the ten-minute and sixty-minute sleep reasons, each said once; the
  cores terminated on sleep; the default loop gated on being awake; waking on a visitor; cores
  surviving a snapshot and inherited with their links cleared; idempotent `coreLaunched`.
- `packages/control-plane/src/cores.test.ts`: the run parameters, the payload, distinct client
  tokens, terminate, and the "which of these are gone" query.
- `packages/control-plane/src/core-node.test.ts`: the host id matches the core's expectation, a
  missing MicroVM id still starts, and the blob reader serves whole blobs and ranges.

Suite: 426 tests, 94 % of lines; lint and the three type-check projects green.

## Why this shape

- The policy is in the pure core so the simulation and the tests see the same decisions the
  deployed machine makes, and so a handover carries the fleet's state rather than rediscovering it
  by listing MicroVMs.
- Cores dial out and have no ingress connector: there is nothing to authenticate to them, and one
  fewer thing to get wrong.
- Naming a core after its MicroVM avoids a registration handshake and works when a core reconnects
  after a rotation, which is exactly when a registration message would be lost.

## Left for later

- The reconciliation fallback (list MicroVMs by tag and adopt strays) is not implemented; the
  ledger plus the pending record in the pointer cover the failure paths we have. If a control
  plane dies without draining, its cores keep dialling the session function and rejoin the
  successor as ordinary nodes — the successor inherits their ids from the snapshot.
- Watching a core's MicroVM state from the control plane (the `gone` query exists but nothing
  polls it) is left to M4's observability pass; a core that dies simply stops heartbeating, and
  its slot is refilled once its record is cleared by the ceiling rule or a handover.
- A real rotation with cores in flight, and the churn numbers, are WP3.5.
