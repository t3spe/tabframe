import type { Ledger } from "@tabframe/core";
import type { Authority } from "./authority.ts";
import type { CoreOptions } from "./core-node.ts";
import type { HookHost, RunVerdict } from "./hooks.ts";
import type { Lifecycle } from "./lifecycle.ts";
import type { Log } from "./log.ts";
import type { SnapshotWriter } from "./snapshot-policy.ts";
import type { Snapshotter } from "./snapshotter.ts";
import type { ProcessState } from "./state.ts";

export interface HookHostDeps {
  state: ProcessState;
  snapshotter: Snapshotter;
  snapshots: SnapshotWriter;
  authority: Authority;
  lifecycle: Lifecycle;
  /** The store base a fresh ledger gets when the payload names none. */
  storeBase: string;
  isListening: () => boolean;
  validate: () => boolean;
  /** Start the core's node; the composition root keeps the dynamic import. */
  startCore: (opts: CoreOptions) => Promise<void>;
  log: Log;
}

/**
 * The lifecycle hooks' host (design §9.3): /run decides the role once, suspend and terminate
 * write a snapshot, validate runs the self-test.
 */
export function createHookHost(deps: HookHostDeps): HookHost {
  const { state, lifecycle, log } = deps;
  const refuse = (reason: string, fields: Record<string, unknown> = {}): RunVerdict => {
    log("run-refused", { reason, ...fields });
    return { ok: false, reason };
  };
  return {
    isListening: deps.isListening,
    onValidate: deps.validate,

    async onRun(payload, microvmId) {
      if (state.identity) return refuse("role already assumed", { role: state.role });
      state.assume({
        role: payload.role,
        generation: payload.generation,
        microvmId,
        fleetSecret: payload.fleetSecret,
        sessionUrl: payload.sessionUrl ?? state.sessionUrl,
      });
      log("run", {
        microvmId,
        role: payload.role,
        generation: payload.generation,
        snapshotKey: payload.snapshotKey,
        hasSecret: payload.fleetSecret !== null,
      });
      if (payload.role === "control-plane") {
        // Adopt from a snapshot when the fleet names one (design §9.4); a missing or unreadable
        // snapshot means a fresh ledger, which idempotency makes safe.
        let adopted: Ledger | null = null;
        if (payload.snapshotKey) {
          try {
            adopted = await deps.snapshotter.read(payload.snapshotKey);
            log(adopted ? "snapshot-adopted" : "snapshot-missing", { key: payload.snapshotKey });
          } catch (err) {
            log("snapshot-unreadable", { key: payload.snapshotKey, error: String(err) });
          }
        }
        // An adopt may have landed while the snapshot was read; its ledger stands.
        if (state.ledger) return refuse("role already assumed", { role: state.role });
        lifecycle.becomeControlPlane(payload.storeBase ?? deps.storeBase, adopted);
        // Asked once the fleet exists: cores follow the version this process runs, so a rolled-back
        // control plane does not launch cores at the image's latest.
        if (microvmId) lifecycle.learnImageVersion(microvmId);
        deps.authority.awaitNaming();
        return { ok: true, role: "control-plane" };
      }
      if (!payload.sessionUrl) return refuse("a core needs a session URL");
      // The node orchestrator is the same code a browser tab runs (design §4, §9.3), started here
      // rather than as a separate process so the image stays one entry point.
      await deps.startCore({
        sessionUrl: payload.sessionUrl,
        microvmId,
        coreToken: payload.coreToken ?? null,
        log,
      });
      log("role", {
        role: "core",
        generation: payload.generation,
        hostId: `core-${microvmId ?? "unknown"}`,
      });
      return { ok: true, role: "core" };
    },

    async onSuspend() {
      log("suspend", { nodes: state.ledger?.nodes.size ?? 0 });
      await deps.snapshots.now("suspend");
    },
    async onResume() {
      log("resume", {});
    },
    async onTerminate() {
      log("terminate", {});
      await deps.snapshots.now("terminate");
    },
  };
}
