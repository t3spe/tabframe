// What the simulation prints about the wire: close codes by name, and one line per event and
// effect for the trace and the verbose log.

import type { Effect, Event } from "@tabframe/core";
import { CLOSE } from "@tabframe/protocol";

export const closeName = (code: number): string =>
  Object.entries(CLOSE).find(([, c]) => c === code)?.[0] ?? String(code);

/** The message type, plus the task and attempt of a result, straight from the frame text. */
export const typeOf = (raw: unknown): string => {
  if (typeof raw !== "string") return "?";
  const t = /"t":"([A-Za-z]+)"/.exec(raw)?.[1] ?? "?";
  if (t !== "result") return t;
  const task = /"taskId":"([^"]+)"/.exec(raw)?.[1] ?? "?";
  const attempt = /"attempt":(\d+)/.exec(raw)?.[1] ?? "?";
  const error = raw.includes('"error":') ? " error" : "";
  return `result ${task}@${attempt}${error}`;
};

export function describeEvent(event: Event): string {
  switch (event.kind) {
    case "connected":
      return `connected ${event.connId} ${event.role}`;
    case "message":
      return `message ${event.connId} ${typeOf(event.raw)}`;
    case "disconnected":
      return `disconnected ${event.connId}`;
    case "tick":
      return "tick";
    case "blobFetched":
      return `blobFetched ${event.purpose.type} ${event.hash.slice(0, 8)} ${event.bytes ? event.bytes.length : "missing"}`;
    case "programRetired":
      return `programRetired ${event.bundle.slice(0, 8)}`;
    case "setDefaultLoop":
      return `setDefaultLoop ${event.loop?.bundle.slice(0, 8) ?? "none"}`;
    case "blobStored":
      return `blobStored ${event.purpose.type} ${event.hash.slice(0, 8)}`;
    case "programAdded":
      return `programAdded ${event.manifest.name}`;
    case "launch":
      return `launch ${event.human ? "human" : "auto"}`;
    case "bundleRejected":
      return `bundleRejected ${event.bundle.slice(0, 8)} ${event.reason}`;
    case "coreLaunched":
      return `coreLaunched ${event.microvmId}`;
    case "coreGone":
      return `coreGone ${event.microvmId}`;
  }
}

export function describeEffect(e: Effect): string {
  switch (e.kind) {
    case "send":
      if (e.msg.t === "assign")
        return `send ${e.connId} assign ${e.msg.taskId}@${e.msg.attempt} ${e.msg.kind}`;
      if (e.msg.t === "cancel") return `send ${e.connId} cancel ${e.msg.taskId}`;
      if (e.msg.t === "command") return `send ${e.connId} command ${e.msg.op}`;
      return `send ${e.connId} ${e.msg.t}`;
    case "close":
      return `close ${e.connId} ${closeName(e.code)}`;
    case "fetchBlob":
      return `fetchBlob ${e.purpose.type} ${e.hash.slice(0, 8)}`;
    case "putBlob":
      return `putBlob ${e.purpose.type} ${e.bytes.length}`;
    case "presign":
      return `presign ${e.connId} ${e.items.length}`;
    case "resolveBundle":
      return `resolveBundle ${e.connId} ${e.bundle.slice(0, 8)}`;
    case "launchCore":
      return "launchCore";
    case "terminateCore":
      return `terminateCore ${e.microvmId}`;
  }
}
