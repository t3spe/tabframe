# WP0.4 — Control-plane process, local mode

**Milestone:** M0 · **Branch:** `wp/0.4-control-plane` · **Merged:** 2026-09-01

## What

`packages/control-plane` is the process that runs in the MicroVM and on a laptop (design §9.3,
§12). This WP lands it in local mode with the M0 behaviors:

- **Two listeners.** The public one carries the node and observer WebSockets (`/node`,
  `/observer`) and the static web bundle; in local mode it also serves the emulated session
  endpoint, `/config.json`, and the local store routes. The private one carries `/health`,
  `/diag`, and the six MicroVM lifecycle hooks. Ports default to 8080/8081 in the image and
  4080/4081 locally (8080 is taken on the development machine); both are env-configurable.
- **Neutral boot state.** In image mode the process listens, answers hooks, holds no role, and
  makes no AWS calls until `/run` delivers a payload; `/run` parses `{microvmId, runHookPayload}`
  with the payload as a JSON string or object, assumes the role once, and refuses a second
  assignment. Local mode is a control plane at boot.
- **Core wiring.** Socket activity and a timer tick become core events; core effects become socket
  sends (canonical JSON) and closes with the protocol's codes.
- **Local store** (design §7.1 contract): `PUT /blob/<hash>` refuses bytes that do not hash to the
  key; `GET` serves immutable bytes with Range support; `HEAD` and 404s as expected.
- **Hooks.** `/ready` reflects listening; `/validate` runs an in-process self-test (hello,
  heartbeat, tick against a scratch ledger); `/resume`, `/suspend`, `/terminate` log for now and
  gain snapshot duties in M3.
- **Diagnostics.** `/health` with role, generation, counts, uptime; `/diag` with a DNS resolution
  timing for the S3 endpoint, which is one of the M0 unknowns.
- `main.ts` prints a `listening` JSON line and shuts down cleanly on SIGTERM.

## How

- `createControlPlane(config, clock)` returns a handle with addresses, role, ledger, store, and
  `close()`. The role is a closure variable that starts `neutral`; `becomeControlPlane` creates
  the ledger with the generation and store base from either the local config or the run payload.
- Upgrades are routed by path before `ws` completes the handshake, so a socket to an unknown path
  or to a neutral process is refused with a plain 503 and never reaches the core.
- The server never validates tokens: in production the MicroVM proxy authenticates every request
  and strips its subprotocols; locally there is nothing to authenticate.
- Effects are executed by connection id; a `close` from the core closes the socket with the code
  and a reason truncated to the WebSocket limit, and the resulting `close` event feeds back as a
  `disconnected` event, which the core ignores for an already-removed connection.
- Presign is not here yet: it is a socket message (D18) and arrives with the store driver in
  WP1.3, after the message exists in the protocol (WP1.1).

## Why

- **Two ports** (D18): hooks and the future fleet endpoints must be unreachable with a browser
  token, so they live on a port browser tokens are not scoped to.
- **Neutral boot** (§9.3): the snapshot is taken before `/run`, and `/validate` runs on a fresh VM
  with no payload, so the process must be able to run with no role and no AWS access.
- **Process tests spawn Node** (design §11.1): the runtime under test is the production one. Bun
  cannot measure coverage inside that child, so the process-only modules (`server.ts`, `main.ts`,
  `static.ts`, `log.ts`) are excluded from the coverage gate and exercised by the spawned-process
  test instead; `hooks.ts` and the store are unit-tested in-process and measured.

## Evidence

- `bun test`: 65 tests across the workspace; the process test spawns `node main.ts` with ports 0
  and checks health and session on the right ports, hello → welcome, snapshot, `nodeJoined`,
  `pong`, `nodeLeft(closed)`, a node declared gone by 4 s of silence with the `declaredGone` close
  code and `nodeLeft(silent)`, invalid and foreign-generation messages closed with the protocol's
  codes, unknown socket paths refused, the store's PUT/GET/HEAD/Range/404/400 paths, every hook,
  the private-only routing of `/health`, and the fallback page. Hooks and the local store are
  100 % covered in-process.
- `mise run lint` clean.

## Dependencies introduced

| Package | Version | Why |
|---|---|---|
| `ws` | 8.21.3 | WebSocket server under Node |
| `@types/ws` | 8.18.1 | types |

## Drift

- Coverage policy: process-only modules are excluded from Bun's gate (see Why). A follow-up could
  merge V8 coverage from the child (`NODE_V8_COVERAGE`) into the report; recorded as open.

## Open

- Merge child-process V8 coverage into the gate (nice to have).
- `/diag` gains the S3 HEAD once the S3 store driver exists (WP1.3).
