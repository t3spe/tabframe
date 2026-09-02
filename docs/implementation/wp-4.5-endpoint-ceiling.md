# WP4.5 — The endpoint ceiling, explained

**Milestone** M4 · **Date** 2026-09-02 · **Where the work is written up** `docs/m3-verification.md`
("ceiling resolved"), design §9.7 Capacity, `packages/infra/scripts/socket-ceiling.ts`.

## What was asked

M3's verification could open only a few dozen simulated clients before the endpoint answered 429,
and the M0 record claimed 250 sustained sockets. Mircea asked to "go deep and understand the
cause"; ideally thousands of concurrent WebSockets.

## What was found

A non-adjustable service quota: **16 concurrent connections per 2-vCPU MicroVM**, enforced by the
platform's proxy per MicroVM — not per token, not per process, and the same from 512 MiB to 6 GB
(`RunMicrovm` takes only `minimumMemoryInMiB`). Open client sockets also count against the private
port, which is why `/handover` saw 429s while browsers were connected (the fleet client now retries
and falls back to the snapshot). The M0 "250 sockets" was a counting error: the probe stamped the
wrong generation, so the control plane closed each socket at once and the probe counted the opens.

The experiment script (`--fresh`, `--live`, `--tokens`, `--procs`, `--attempts`, `--gap`, `--hold`)
and its table are in `docs/m3-verification.md`.

## Decision (Mircea, 2026-09-02)

Document the ceiling now and scope the demo to it; after M5, evaluate moving the control plane to
an EC2 instance (WP4.6 keeps the options). Design §9.7 records the number and the consequence: a
dashboard costs one connection and each node one more, so a MicroVM control plane serves about a
dozen nodes at a time; cloud cores and the rotation are unaffected.
