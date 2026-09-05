// What every panel renders from: the elements, the blob cache, the page's deps, and the one
// selection shared across panels (a task, a file, a ledger row, a root being browsed).
import type { BlobCache } from "../blob-cache.ts";
import type { ClusterState } from "../cluster-state.ts";
import type { ControlRequest } from "../controls.ts";
import { $ } from "../dom.ts";
import type { PanelName } from "../page-mode.ts";
import type { FileEntry } from "../result.ts";
import type { BlobSource } from "../tiles.ts";

export interface PanelDeps {
  /** The store as the page reaches it right now (the demo's in-memory store, or the CDN). */
  blobs(): BlobSource;
  /** Where the store's blobs are addressed from, `<base>/<hash>`; null for the demo's in-page store. */
  storeBase(): string | null;
  /** Issue a control; false when the machine is not there to take it. */
  send(control: ControlRequest): boolean;
  /** Ask the page to render again once a fetch has landed or a panel's own state moved. */
  rerender(): void;
  now(): number;
  /** The one panel this page shows full-width in its own tab, or null on the dashboard. */
  panelMode?: PanelName | null;
  /** A file to show at once on the files tab, from the page's query. */
  openFile?: FileEntry | null;
  /** A filesystem root to browse at once, from the page's query. */
  openRoot?: string | null;
}

export interface PanelEls {
  programs: HTMLDivElement;
  queue: HTMLUListElement;
  strip: HTMLDivElement;
  failure: HTMLDivElement;
  warnings: HTMLUListElement;
  result: HTMLDivElement;
  files: HTMLDivElement;
  filesRoot: HTMLSpanElement;
  filePreview: HTMLDivElement;
  ledgerPreview: HTMLDivElement;
  taskDetail: HTMLDivElement;
  ledger: HTMLTableSectionElement;
  ledgerNote: HTMLParagraphElement;
  ledgerSummary: HTMLParagraphElement;
  filesSummary: HTMLParagraphElement;
  followUp: HTMLDivElement;
  killExecution: HTMLButtonElement;
}

export function panelEls(root: ParentNode): PanelEls {
  return {
    programs: $<HTMLDivElement>("#programs", root),
    queue: $<HTMLUListElement>("#queue", root),
    strip: $<HTMLDivElement>("#strip", root),
    failure: $<HTMLDivElement>("#failure", root),
    warnings: $<HTMLUListElement>("#warnings", root),
    result: $<HTMLDivElement>("#result", root),
    files: $<HTMLDivElement>("#files", root),
    filesRoot: $<HTMLSpanElement>("#filesRoot", root),
    filePreview: $<HTMLDivElement>("#filePreview", root),
    ledgerPreview: $<HTMLDivElement>("#ledgerPreview", root),
    taskDetail: $<HTMLDivElement>("#taskDetail", root),
    ledger: $<HTMLTableSectionElement>("#ledger tbody", root),
    ledgerNote: $<HTMLParagraphElement>("#ledgerNote", root),
    ledgerSummary: $<HTMLParagraphElement>("#ledgerSummary", root),
    filesSummary: $<HTMLParagraphElement>("#filesSummary", root),
    followUp: $<HTMLDivElement>("#followUp", root),
    killExecution: $<HTMLButtonElement>("#killExecution", root),
  };
}

/** A ledger row whose bytes the ledger tab previews. */
export interface LedgerPick {
  hash: string;
  taskId: string;
  size: number | null;
}

export interface Selection {
  task: string | null;
  file: FileEntry | null;
  ledger: LedgerPick | null;
  /** A root the reader chose; null follows the execution. */
  browsingRoot: string | null;
  /** A viewer tab opened on a file keeps it across executions until the reader browses elsewhere. */
  pinned: boolean;
  dismissedFailure: string | null;
}

export interface PanelContext {
  readonly els: PanelEls;
  readonly cache: BlobCache;
  readonly deps: PanelDeps;
  readonly selection: Selection;
  /** The state last rendered, for a click that redraws one panel at once. */
  last: ClusterState | null;
  /** True when `signature` differs from what `panel` last drew; a panel redraws only then. */
  changed(panel: string, signature: string): boolean;
  selectTask(taskId: string | null): void;
  selectFile(f: FileEntry | null): void;
  selectLedger(row: LedgerPick | null): void;
  browseRoot(root: string | null): void;
}
