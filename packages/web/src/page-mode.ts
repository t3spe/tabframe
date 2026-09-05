// What the page's query says about this tab: demo or live, observer or lender, the dashboard or one
// panel full-width, and what the demo should do. Pure, so the links between tabs are unit-tested.
import { HASH_RE } from "@tabframe/store/hash";
import { DEMO_CYCLE, type DemoProgram } from "./demo.ts";
import type { FileEntry } from "./result.ts";

/** The panels a tab can show alone, by query name → section id. */
export const PANELS = {
  ledger: "ledgerPanel",
  files: "filesPanel",
  activity: "activityPanel",
} as const;
export type PanelName = keyof typeof PANELS;

export interface PageMode {
  demo: boolean;
  /** The one panel this tab shows full-width, or null on the dashboard. */
  panel: PanelName | null;
  /** True for `?observe`, the demo, and a panel tab: none of them lends a node (rule R3). */
  observeOnly: boolean;
  /** A file the files tab shows at once, pinned by its query. */
  openFile: FileEntry | null;
  /** A filesystem root the files tab browses at once. */
  openRoot: string | null;
  /** Demo: pause once this many tasks of an execution are done; 0 never pauses. */
  pauseAtDone: number;
  /** Demo: 1 is real time. */
  speed: number;
  /** Demo: start the cycle at this program. */
  startWith: DemoProgram | null;
  /** Demo: pause once the first execution has ended. */
  hold: boolean;
}

/** The query keys a panel tab or a file viewer adds; a link back to the dashboard drops them. */
const VIEWER_KEYS = ["root", "file", "path", "size"];

export function readPageMode(search: string): PageMode {
  const params = new URLSearchParams(search);
  const demo = params.has("demo");
  const p = params.get("panel");
  const panel = p && p in PANELS ? (p as PanelName) : null;
  const file = params.get("file") ?? "";
  const path = params.get("path");
  const root = params.get("root") ?? "";
  const program = params.get("program");
  return {
    demo,
    panel,
    observeOnly: params.has("observe") || demo || panel !== null,
    openFile:
      panel === "files" && HASH_RE.test(file) && path
        ? { hash: file, path, size: Number(params.get("size") ?? "0") || 0 }
        : null,
    openRoot: panel === "files" && HASH_RE.test(root) ? root : null,
    pauseAtDone: Number(params.get("pause") ?? "0") || 0,
    speed: Number(params.get("speed") ?? "1") || 1,
    startWith:
      program !== null && (DEMO_CYCLE as readonly string[]).includes(program)
        ? (program as DemoProgram)
        : null,
    hold: params.has("hold"),
  };
}

/** A panel tab's way back (rule R7): the dashboard with this tab's own query, minus the panel's. */
export function backLink(search: string): string {
  const q = new URLSearchParams(search);
  for (const k of ["panel", ...VIEWER_KEYS]) q.delete(k);
  const query = q.toString();
  return query ? `/?${query}` : "/";
}

/**
 * A panel in its own tab, carrying the page's own query so a demo opens the same demo and a live
 * page opens an observer; only the panel differs.
 */
export function panelLink(search: string, panel: string, demo: boolean): string {
  const q = new URLSearchParams(search);
  for (const k of VIEWER_KEYS) q.delete(k);
  if (!demo) q.set("observe", "");
  q.set("panel", panel);
  return `/?${q.toString()}`;
}

/** The files tab with one file selected and its filesystem root pinned. */
export function fileViewerUrl(search: string, root: string, f: FileEntry): string {
  const q = new URLSearchParams(search);
  for (const k of VIEWER_KEYS) q.delete(k);
  if (!q.has("demo")) q.set("observe", "");
  q.set("panel", "files");
  q.set("root", root);
  q.set("file", f.hash);
  q.set("path", f.path);
  if (f.size) q.set("size", String(f.size));
  return `/?${q.toString()}`;
}
