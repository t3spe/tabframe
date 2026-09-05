// The process API: what `packages/control-plane` needs to run the core. Tests and the simulation
// reach the rest through `@tabframe/core/testing`.
export { type ApplyOptions, apply } from "./apply.ts";
export type { Effect, Event } from "./events.ts";
export { microvmIdOfHost } from "./fleet.ts";
export { beginHandover, drain } from "./handover.ts";
export { type Clock, systemClock } from "./interfaces.ts";
export { type ConnRole, createLedger, type Ledger } from "./ledger.ts";
export { DEFAULT_TASK_LIMITS, HANDOVER_LEASE_MS } from "./policy.ts";
export { adoptLedger, deserializeLedger, serializeLedger } from "./snapshot.ts";
