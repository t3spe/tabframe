import type { Effect, Event, Ledger } from "@tabframe/core";
import { CLOSE, encode, PROTOCOL_VERSION } from "@tabframe/protocol";
import type { StoreDriver } from "@tabframe/store";
import type { BundleResolution } from "./bundles.ts";
import type { CoreFleet } from "./cores.ts";
import type { Inflight } from "./inflight.ts";
import type { Log } from "./log.ts";
import type { SocketGateway } from "./sockets.ts";

/** What the control plane will read from the store on an untrusted party's say-so. */
export const FETCH_CAPS = { stageSpec: 1024 * 1024, inheritRoot: 4 * 1024 * 1024 } as const;

export interface EffectExecutorDeps {
  gateway: Pick<SocketGateway, "get">;
  store: StoreDriver;
  cores: () => CoreFleet | null;
  authoritative: () => boolean;
  resolve: (bundle: string) => Promise<BundleResolution>;
  dispatch: (event: Event) => void;
  ledger: () => Ledger | null;
  generation: () => number;
  inflight: Inflight;
  log: Log;
}

/** Turns the core's effects into socket sends and closes, store traffic, and fleet calls. */
export function createEffectExecutor(deps: EffectExecutorDeps): (effects: Effect[]) => void {
  const { gateway, store, inflight, log, dispatch } = deps;

  // A frame the protocol refuses to encode (over 64 KB) closes that connection instead of
  // throwing through the dispatch: the ledger is already advanced.
  function sendTo(connId: string, t: string, frame: () => string): void {
    const ws = gateway.get(connId);
    if (!ws || ws.readyState !== ws.OPEN) return;
    try {
      ws.send(frame());
    } catch (err) {
      log("send-failed", { connId, t, error: String(err) });
      ws.close(CLOSE.invalidMessage, "frame too large");
    }
  }

  function one(e: Effect): void {
    switch (e.kind) {
      case "send":
        sendTo(e.connId, e.msg.t, () => encode(e.msg));
        break;
      case "close": {
        const ws = gateway.get(e.connId);
        if (ws) ws.close(e.code, e.reason.slice(0, 120));
        break;
      }
      case "presign":
        inflight.track(
          store
            .presign(e.items)
            .then((urls) =>
              sendTo(e.connId, "presigned", () =>
                encode({ t: "presigned", v: PROTOCOL_VERSION, gen: deps.generation(), urls }),
              ),
            )
            .catch((err) => log("presign-failed", { error: String(err) })),
        );
        break;
      case "fetchBlob":
        inflight.track(
          store
            .get(
              e.hash,
              e.purpose.type === "stageSpec" ? FETCH_CAPS.stageSpec : FETCH_CAPS.inheritRoot,
            )
            .then((bytes) =>
              dispatch({ kind: "blobFetched", hash: e.hash, bytes, purpose: e.purpose }),
            )
            .catch((err) => {
              // An error is not "missing": the core retries the effect and fails only past a cap.
              log("fetch-failed", { hash: e.hash, error: String(err) });
              dispatch({
                kind: "blobFetched",
                hash: e.hash,
                bytes: null,
                purpose: e.purpose,
                error: String(err).slice(0, 200),
              });
            }),
        );
        break;
      case "launchCore": {
        const fleet = deps.cores();
        if (!fleet) break;
        if (!deps.authoritative()) {
          log("core-launch-deferred", { reason: "not yet named by the pointer" });
          break;
        }
        inflight.track(
          fleet
            .launch()
            .then(({ microvmId, token }) => {
              if (deps.ledger()?.meta.phase !== "active") {
                // Acked after a handover: no surviving ledger would know this core.
                log("core-launched-late", { microvmId });
                inflight.track(fleet.terminate(microvmId).catch(() => {}));
                return;
              }
              log("core-launched", { microvmId });
              dispatch({ kind: "coreLaunched", microvmId, token });
            })
            .catch((err) => log("core-launch-failed", { error: String(err) })),
        );
        break;
      }
      case "terminateCore": {
        const fleet = deps.cores();
        if (!fleet) break;
        const { microvmId } = e;
        inflight.track(
          fleet
            .terminate(microvmId)
            .then(() => log("core-terminated", { microvmId }))
            .catch((err) => log("core-terminate-failed", { microvmId, error: String(err) })),
        );
        break;
      }
      case "resolveBundle": {
        const { bundle, connId, params, inherit } = e;
        inflight.track(
          deps
            .resolve(bundle)
            .then((r) => {
              if (!r.ok) {
                log("bundle-rejected", { bundle: bundle.slice(0, 12), reason: r.reason });
                dispatch({ kind: "bundleRejected", bundle, connId, reason: r.reason });
                return;
              }
              log("bundle-accepted", { bundle: bundle.slice(0, 12), name: r.manifest.name });
              dispatch({
                kind: "programAdded",
                bundle: r.bundle,
                module: r.module,
                manifest: r.manifest,
                files: r.files,
              });
              dispatch({ kind: "launch", bundle, params, human: true, inherit, connId });
            })
            .catch((err) => {
              log("bundle-failed", { bundle: bundle.slice(0, 12), error: String(err) });
              dispatch({ kind: "bundleRejected", bundle, connId, reason: "store error" });
            }),
        );
        break;
      }
      case "putBlob":
        inflight.track(
          store
            .put(e.bytes)
            .then((hash) =>
              dispatch({ kind: "blobStored", hash, size: e.bytes.length, purpose: e.purpose }),
            )
            .catch((err) => log("put-failed", { error: String(err) })),
        );
        break;
    }
  }

  return (effects) => {
    for (const e of effects) one(e);
  };
}
