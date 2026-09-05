// The editor in its own tab: its own observer socket, and a pause on the machine for as long as
// this tab holds it — launching or closing resumes it, and so does the control plane by itself
// when this socket goes away.
import type { ClusterState } from "./cluster-state.ts";
import type { EditorDebug } from "./debug.ts";
import { $ } from "./dom.ts";
import { mountEditor } from "./editor.ts";
import { type MachineState, ObserverClient } from "./observer.ts";
import { loadSessionUrl } from "./page-config.ts";

const machineEl = $<HTMLSpanElement>("#machine");
const pauseEl = $<HTMLSpanElement>("#pauseState");
const listeners = new Set<(state: ClusterState) => void>();
let storeBase: string | null = null;
let client: ObserverClient | null = null;
/**
 * The hold this tab has on the machine: wanted until the machine is live, held while it is,
 * released for good after its launch or its close — a resubscribe after that must not pause the
 * machine again under the person's own running program.
 */
let hold: "wanted" | "held" | "released" = "wanted";

function setMachine(state: MachineState, detail?: string): void {
  machineEl.textContent = detail ? `${state} · ${detail}` : state;
  machineEl.className = `pill ${state === "live" ? "live" : state === "off" || state === "outdated" ? "off" : "wait"}`;
  if (state === "live") {
    // Every live socket asks again: a reconnect (a rotation, a gap) is a new holder.
    if (hold === "released") return;
    client?.send({ t: "pause" });
    hold = "held";
    pauseEl.textContent =
      "the machine is paused while this tab is open — in-flight tasks finish, nothing new starts; launch or close to resume";
  } else if (state === "off" || state === "outdated") {
    if (hold === "held") hold = "wanted";
    pauseEl.textContent = "no machine to pause";
  }
}

function resume(why: "launch" | "close" = "close"): void {
  const was = hold;
  hold = "released";
  if (was !== "held") return;
  client?.send({ t: "resume" });
  pauseEl.textContent =
    why === "launch"
      ? "launched · the pause ended and the machine runs your program · keep editing, or close this tab"
      : "resumed";
}

/** The demo's editor: the compile is real, there is no machine to pause or launch on. */
function mainDemo(): void {
  machineEl.textContent = "demo";
  machineEl.className = "pill live";
  pauseEl.textContent =
    "demo · the editor compiles here, nothing is sent anywhere; launching needs the live machine (the plain address)";
  const editor = mountEditor($<HTMLElement>("#editor"), {
    connected: () => false,
    storeBase: () => null,
    presign: () => Promise.reject(new Error("demo: nothing is sent anywhere")),
    launch: () => "refused",
    subscribe: () => () => undefined,
    demo: true,
  });
  $<HTMLElement>("#editor").addEventListener("editor-closed", () => {
    setTimeout(() => window.close(), 150);
  });
  const debug: EditorDebug = { editor, client: null };
  window.tabframe = debug;
}

async function main(): Promise<void> {
  if (new URLSearchParams(location.search).has("demo")) return mainDemo();
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
    launch: (bundle, params) =>
      client?.sendStatus({ t: "launch", bundle, params, inherit: null }) ?? "refused",
    // The pause ends when the machine has the launch, not when the page sent it.
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
  const debug: EditorDebug = {
    editor,
    get client() {
      return client;
    },
  };
  window.tabframe = debug;
  void client.start();
}

/** A page that failed to mount or connect says so instead of sitting on "connecting…". */
function showFatal(err: unknown): void {
  console.error(err);
  const message = err instanceof Error ? err.message : String(err);
  machineEl.textContent = `failed · ${message}`;
  machineEl.className = "pill off";
  pauseEl.textContent = `this page hit an error and stopped: ${message}; reload to try again`;
}

main().catch(showFatal);
