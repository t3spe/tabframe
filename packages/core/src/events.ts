import type { ControlPlaneToNode, ControlPlaneToObserver } from "@tabframe/protocol";
import type { ConnRole } from "./ledger.ts";

/** Inbound events. The process turns socket activity and timers into these. */
export type Event =
  | { kind: "connected"; connId: string; role: ConnRole }
  | { kind: "message"; connId: string; raw: unknown }
  | { kind: "disconnected"; connId: string }
  | { kind: "tick" };

/** Outbound effects. The process executes them; the core never touches a socket. */
export type Effect =
  | { kind: "send"; connId: string; msg: ControlPlaneToNode | ControlPlaneToObserver }
  | { kind: "close"; connId: string; code: number; reason: string };
