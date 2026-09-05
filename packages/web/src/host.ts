// The host page's entry: read the query, mount the dashboard, then feed it — the scripted demo
// inside the page, or the observer socket to a live control plane.
import { applyMessage, withRedundancy } from "./cluster-state.ts";
import { mountDashboard } from "./dashboard.ts";
import type { TabframeDebug } from "./debug.ts";
import { BoundedBlobMap } from "./demo/store.ts";
import { type DemoHandle, startDemo } from "./demo.ts";
import { ObserverClient } from "./observer.ts";
import { loadSessionUrl } from "./page-config.ts";
import { readPageMode } from "./page-mode.ts";
import { storeSource } from "./tiles.ts";

const mode = readPageMode(location.search);
const demoStore = new BoundedBlobMap();
const dash = mountDashboard(document, mode, demoStore);
let client: ObserverClient | null = null;
let demo: DemoHandle | null = null;

function expose(): void {
  const debug: TabframeDebug = {
    client,
    locals: dash.locals,
    hostId: dash.hostId,
    tiles: dash.tiles,
    demo,
    panels: dash.panels,
    get state() {
      return dash.state;
    },
    openEditor: dash.openEditor,
  };
  window.tabframe = debug;
}

async function main(): Promise<void> {
  if (mode.demo) {
    dash.setMachine("live", "demo");
    const handle = startDemo({
      apply: (msg) => dash.onCluster(applyMessage(dash.state, msg, dash.clock.now())),
      store: demoStore,
      speed: mode.speed,
      pauseAtDone: mode.pauseAtDone,
      clock: dash.clock,
      onPause: () => {
        document.body.dataset.demoPaused = "1";
      },
      ...(mode.startWith ? { startWith: mode.startWith } : {}),
      holdAfterFirst: mode.hold,
    });
    demo = handle;
    // The page knows the redundancy value it asked for; the demo's echo, like the wire's, carries none.
    dash.setControls((control) => {
      if (control.t === "setRedundancy") dash.onCluster(withRedundancy(dash.state, control.on));
      handle.control(control);
      return true;
    });
    expose();
    return;
  }
  dash.setMachine("connecting");
  const sessionUrl = await loadSessionUrl(location.origin, {
    onRetry: (attempt, delayMs, reason) =>
      dash.setMachine(
        "connecting",
        `the page's configuration could not be fetched (${reason}); trying again in ${Math.round(delayMs / 1000)} s (attempt ${attempt})`,
      ),
  });
  dash.setSessionUrl(sessionUrl);
  let spawnedOnce = false;
  const observer = new ObserverClient(sessionUrl, {
    onState: dash.setMachine,
    onDropped: (count) => {
      dash.notice.show(
        `${count === 1 ? "a click" : `${count} clicks`} made during the reconnect ${count === 1 ? "was" : "were"} not sent; try again`,
        6_000,
      );
      dash.scheduleRender();
    },
    onCluster: dash.onCluster,
    onSession: (session) => {
      dash.setStore(session.storeBase, storeSource(session.storeBase));
      // A lending tab brings one node with it, once; a person spawns the rest.
      if (!mode.observeOnly && dash.locals.size === 0 && !spawnedOnce) {
        spawnedOnce = true;
        dash.locals.spawn(1);
      }
    },
  });
  client = observer;
  dash.setControls((control) => observer.send(control));
  expose();
  await observer.start();
}

/** A page that failed to mount or connect says so instead of sitting on "Connecting…". */
function showFatal(err: unknown): void {
  console.error(err);
  const message = err instanceof Error ? err.message : String(err);
  const pill = document.querySelector<HTMLElement>("#machine");
  if (pill) {
    pill.textContent = `failed · ${message}`;
    pill.className = "pill off";
  }
  const hint = document.querySelector<HTMLElement>("#bannerHint");
  if (hint)
    hint.textContent = `This page hit an error and stopped: ${message}. Reload to try again.`;
}

main().catch(showFatal);
