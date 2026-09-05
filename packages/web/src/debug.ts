// What the pages hang on `window.tabframe` for the browser suites and the screenshot script. One
// declaration, so a renamed field fails to compile in the suites instead of at runtime.
import type { ClusterState } from "./cluster-state.ts";
import type { DemoHandle } from "./demo.ts";
import type { EditorHandle } from "./editor.ts";
import type { LocalNodes } from "./local-nodes.ts";
import type { ObserverClient } from "./observer.ts";
import type { Panels } from "./panels.ts";
import type { TileView } from "./tiles.ts";

/** The dashboard's surface. */
export interface TabframeDebug {
  client: ObserverClient | null;
  locals: LocalNodes;
  hostId: string;
  tiles: TileView;
  demo: DemoHandle | null;
  panels: Panels;
  readonly state: ClusterState;
  openEditor(): Window | null;
}

/** The editor tab's surface. */
export interface EditorDebug {
  editor: EditorHandle;
  readonly client: ObserverClient | null;
}

declare global {
  interface Window {
    tabframe?: TabframeDebug | EditorDebug;
  }
}
