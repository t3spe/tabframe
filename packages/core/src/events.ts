import type {
  ControlPlaneToNode,
  ControlPlaneToObserver,
  FsManifest,
  ProgramManifest,
} from "@tabframe/protocol";
import type { ConnRole } from "./ledger.ts";

/** Why the process fetched or stored a blob on the core's behalf. */
export type BlobPurpose =
  | { type: "stageSpec"; executionId: string; taskId: string }
  /** `stage` is -1 for an execution's initial filesystem (bundle plus what it inherits). */
  | { type: "manifest"; executionId: string; stage: number }
  /** Does the root an execution inherits still exist? (design §5.4, expired-root fallback) */
  | { type: "inheritRoot"; executionId: string };

/** Inbound events. The process turns socket activity, timers, and store I/O into these. */
export type Event =
  | { kind: "connected"; connId: string; role: ConnRole }
  | { kind: "message"; connId: string; raw: unknown }
  | { kind: "disconnected"; connId: string }
  | { kind: "tick" }
  | { kind: "blobFetched"; hash: string; bytes: Uint8Array | null; purpose: BlobPurpose }
  | { kind: "blobStored"; hash: string; size: number; purpose: BlobPurpose }
  | {
      kind: "programAdded";
      bundle: string;
      module: string;
      manifest: ProgramManifest;
      /** The bundle's files; an execution's filesystem starts here (design §5.4). */
      files?: FsManifest["files"];
    }
  | {
      kind: "launch";
      bundle: string;
      params: Record<string, unknown>;
      human: boolean;
      inherit: string | "latest" | null;
      /** The observer that asked, so a refusal can be told to it. */
      connId?: string;
    }
  /** The process finished checking an uploaded bundle (design §5.2, §5.5). */
  | { kind: "bundleRejected"; bundle: string; connId: string; reason: string }
  /** The process launched a cloud core, or found one gone (design §6.8). */
  | { kind: "coreLaunched"; microvmId: string }
  | { kind: "coreGone"; microvmId: string };

/** Outbound effects. The process executes them; the core never touches a socket or the store. */
export type Effect =
  | { kind: "send"; connId: string; msg: ControlPlaneToNode | ControlPlaneToObserver }
  | { kind: "close"; connId: string; code: number; reason: string }
  | { kind: "fetchBlob"; hash: string; purpose: BlobPurpose }
  | { kind: "putBlob"; bytes: Uint8Array; purpose: BlobPurpose }
  | { kind: "presign"; connId: string; items: Array<{ hash: string; size: number }> }
  /**
   * An observer launched a bundle the ledger does not know. The process fetches its manifest and
   * module, validates them (imports, exports, size, declared memory), and answers with a
   * `programAdded` event followed by the same launch, or with `bundleRejected` (design §5.2).
   */
  /** Keep the cloud-core fleet at its desired size (design §6.8); the process calls AWS. */
  | { kind: "launchCore" }
  | { kind: "terminateCore"; microvmId: string }
  | {
      kind: "resolveBundle";
      bundle: string;
      connId: string;
      params: Record<string, unknown>;
      inherit: string | "latest" | null;
    };
