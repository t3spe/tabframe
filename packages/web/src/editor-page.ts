// The editor in its own tab (WP6.4): its own observer socket, the same editor as before, and a
// pause on the machine for as long as this tab lives — launching or closing resumes it, and so
// does the control plane by itself when this socket goes away.

import type { ClusterState } from "./cluster-state.ts";
import { mountEditor } from "./editor.ts";
import { type MachineState, ObserverClient } from "./observer.ts";
import { loadSessionUrl } from "./page-config.ts";

const $ = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};
const machineEl = $<HTMLSpanElement>("#machine");
const pauseEl = $<HTMLSpanElement>("#pauseState");
const listeners = new Set<(state: ClusterState) => void>();
let storeBase: string | null = null;
let client: ObserverClient | null = null;
let paused = false;
/** Whether this tab still wants the machine held (WP8.1): not after its launch, not after close. */
let holdWanted = true;
let lastLaunch: "sent" | "held" | "refused" = "sent";

function setMachine(state: MachineState, detail?: string): void {
  machineEl.textContent = detail ? `${state} · ${detail}` : state;
  machineEl.className = `pill ${state === "live" ? "live" : state === "off" || state === "outdated" ? "off" : "wait"}`;
  if (state === "live") {
    // Every live socket asks again — a reconnect (a rotation, a gap) is a new holder — but only
    // while this tab still wants the hold (WP8.1): after its launch a resubscribe used to pause
    // the machine again under the person's own running program.
    if (!holdWanted) return;
    client?.send({ t: "pause" });
    paused = true;
    pauseEl.textContent =
      "the machine is paused while this tab is open — in-flight tasks finish, nothing new starts; launch or close to resume";
  } else if (state === "off" || state === "outdated") {
    paused = false;
    pauseEl.textContent = "no machine to pause";
  }
}

function resume(why: "launch" | "close" = "close"): void {
  holdWanted = false;
  if (!paused) return;
  paused = false;
  client?.send({ t: "resume" });
  pauseEl.textContent =
    why === "launch"
      ? "launched · the pause ended and the machine runs your program · keep editing, or close this tab"
      : "resumed";
}

/** The demo's editor (WP7.7): the compile is real, there is no machine to pause or launch on. */
function mainDemo(): void {
  machineEl.textContent = "demo";
  machineEl.className = "pill live";
  pauseEl.textContent =
    "demo · the editor compiles here, nothing is sent anywhere; launching needs the live machine (the plain address)";
  const editor = mountEditor($<HTMLElement>("#editor"), {
    connected: () => false,
    storeBase: () => null,
    presign: () => Promise.reject(new Error("demo: nothing is sent anywhere")),
    launch: () => false,
    subscribe: () => () => undefined,
    demo: true,
  });
  $<HTMLElement>("#editor").addEventListener("editor-closed", () => {
    setTimeout(() => window.close(), 150);
  });
  (window as unknown as { tabframe: unknown }).tabframe = { editor, client: null };
}

async function main(): Promise<void> {
  if (new URLSearchParams(location.search).has("demo")) return mainDemo();
  // Retried with a backoff (WP8.3): the editor used to sit on its static "connecting" text for ever.
  const sessionUrl = await loadSessionUrl(location.origin, {
    onRetry: (attempt, delayMs) =>
      setMachine(
        "connecting",
        `configuration not fetched yet; trying again in ${Math.round(delayMs / 1000)} s (attempt ${attempt})`,
      ),
  });
  client = new ObserverClient(sessionUrl, {
    onState: setMachine,
    onDropped: (count) => {
      const info = document.querySelector<HTMLElement>("#launchInfo");
      if (info) {
        info.textContent = `${count === 1 ? "a message" : `${count} messages`} sent during the reconnect ${count === 1 ? "was" : "were"} dropped; the launch did not reach the machine — launch again`;
        info.className = "bad";
      }
    },
    onCluster: (state) => {
      for (const l of listeners) l(state);
    },
    onSession: (session) => {
      storeBase = session.storeBase;
    },
  });
  const editor = mountEditor($<HTMLElement>("#editor"), {
    connected: () => client?.connected ?? false,
    storeBase: () => storeBase,
    presign: (items) =>
      client ? client.presign(items) : Promise.reject(new Error("not connected")),
    launch: (bundle, params) => {
      lastLaunch = client?.sendStatus({ t: "launch", bundle, params, inherit: null }) ?? "refused";
      return lastLaunch !== "refused";
    },
    launchStatus: () => (lastLaunch === "held" ? "held" : "sent"),
    // The pause ends when the machine has the launch, not when the page sent it (WP8.2).
    onLaunched: () => resume("launch"),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  $<HTMLElement>("#editor").addEventListener("editor-closed", () => {
    resume();
    setTimeout(() => window.close(), 150);
  });
  window.addEventListener("pagehide", () => resume());
  (window as unknown as { tabframe: unknown }).tabframe = {
    editor,
    get client() {
      return client;
    },
  };
  void client.start();
}

void main();
