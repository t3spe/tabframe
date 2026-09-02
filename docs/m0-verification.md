# M0 verification

Run on 2026-09-02 against the deployed machine with `mise run verify` (`packages/infra/scripts/verify-m0.ts`),
which launches a throwaway MicroVM from the deployed image with a 60-second idle policy, exercises it
through the real proxy, and terminates it. Account ids and tokens never reach the output.

| Check | Result | Pass |
|---|---|---|
| Lambda concurrency | 10 concurrent executions (account default; increase to 1000 requested and pending) | yes — jitter is the mechanism |
| MicroVM memory quota | 8 GB | yes |
| Boot to RUNNING | 2 s from `run-microvm` to RUNNING (snapshot boot) | yes |
| Run hook → control plane | the process assumed the control-plane role with the generation from the payload | yes |
| DNS and S3 reachability inside the image | `s3.us-west-2.amazonaws.com` resolves in 5 ms; Node v22.22.3 in the image | yes |
| WebSocket frames count as idle-policy traffic | still RUNNING after 105 s of heartbeat frames on one socket with a 60 s idle policy; socket stayed open | yes |
| Socket survives its token's expiry | a socket opened with a 1-minute token was still open after 130 s | yes |
| Endpoint request rate | first throttling (429) at 50 requests per second on the private port | yes (≥ 50) |
| Concurrent WebSocket connections | first run: 48 of 250 (opened in a burst → the request-rate limit); paced at 4 opens per second: 250 of 250 open and stable for 20 s — **wrong, see the correction below** | no |
| Per-connection message rate | 15 messages per second for 30 s, socket open | yes |
| Token minting burst | 20 tokens in 243 ms, none throttled | info |
| Resume latency | 0.7 s from a suspended 1 GB MicroVM to the first response | yes |

## What it means for the design

- **No fallback fired.** Idle detection works on socket frames, tokens matter only at connect time,
  DNS works inside the image, resume is sub-second, and 250 sustained sockets are fine.
- **The one number that shapes code: about 50 requests per second per endpoint.** A WebSocket
  upgrade is a request, so a rotation must spread reconnects below that rate. The drain-time
  jitter window is now **30 ms per connected client with a 2 s floor** (was 25 ms), which keeps a
  300-client rotation near 33 upgrades per second. Heartbeats and events are frames on open
  sockets and do not count.
- **Boot and resume are fast enough to be invisible**: a control plane launched from the snapshot is
  serving in about two seconds, and a suspended one answers in under a second.
- **Tokens are cheap to mint**, so the shared cached token in the session function is a comfort,
  not a necessity.

## Notes

- The first `--only connections` rerun aborted on a transient HTML error page from the MicroVMs
  API during launch and left its throwaway VM suspended; it was found and terminated by hand.
  The runbook now terminates in a `finally`, but an aborted launch before the VM id is known
  still needs the operator's `mise run down` or a manual terminate. Recorded as an open item.

## Correction (2026-09-02, WP4.5)

The "250 of 250 open" row was a counting error. The check attached its `onclose` handlers only
after the opening loop and sent no heartbeats during it, so every socket was declared gone four
seconds after its hello and closed before anyone was counting; at the end about sixteen were
actually alive, which is exactly the platform's limit. Re-measured with heartbeats and the right
generation (`packages/infra/scripts/socket-ceiling.ts`), a fresh MicroVM holds **16 concurrent
connections** and answers 429 to the next — the account's non-adjustable *Concurrent connections per
2 vCPU MicroVM* quota. The full investigation is in `docs/m3-verification.md` and design §9.7.

