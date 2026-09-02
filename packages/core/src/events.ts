import type {
  ControlPlaneToNode,
  ControlPlaneToObserver,
  ProgramManifest,
} from "@tabframe/protocol";
import type { ConnRole } from "./ledger.ts";

/** Why the process fetched or stored a blob on the core's behalf. */
export type BlobPurpose =
  | { type: "stageSpec"; executionId: string; taskId: string }
  | { type: "manifest"; executionId: string; stage: number };

/** Inbound events. The process turns socket activity, timers, and store I/O into these. */
export type Event =
  | { kind: "connected"; connId: string; role: ConnRole }
  | { kind: "message"; connId: string; raw: unknown }
  | { kind: "disconnected"; connId: string }
  | { kind: "tick" }
  | { kind: "blobFetched"; hash: string; bytes: Uint8Array | null; purpose: BlobPurpose }
  | { kind: "blobStored"; hash: string; size: number; purpose: BlobPurpose }
  | { kind: "programAdded"; bundle: string; module: string; manifest: ProgramManifest }
  | {
      kind: "launch";
      bundle: string;
      params: Record<string, unknown>;
      human: boolean;
      inherit: string | "latest" | null;
    };

/** Outbound effects. The process executes them; the core never touches a socket or the store. */
export type Effect =
  | { kind: "send"; connId: string; msg: ControlPlaneToNode | ControlPlaneToObserver }
  | { kind: "close"; connId: string; code: number; reason: string }
  | { kind: "fetchBlob"; hash: string; purpose: BlobPurpose }
  | { kind: "putBlob"; bytes: Uint8Array; purpose: BlobPurpose }
  | { kind: "presign"; connId: string; items: Array<{ hash: string; size: number }> };
