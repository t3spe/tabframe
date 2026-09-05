// Dashboard v2 panels (design §5.1, §6.7, §8.3): programs, queue, the stage strip, the result of
// a `bars` or `text` program, the files behind an execution's root, a task's detail, the ledger of
// settled tasks, and failure surfacing. No framework: each panel is a render function over the
// state that rebuilds its DOM only when what it shows has changed, so buttons stay put under a
// finger. The panels share one selection through the context; the selects here redraw the one
// panel a click changes, and ask the page for a render otherwise.
import { BlobCache } from "./blob-cache.ts";
import type { ClusterState } from "./cluster-state.ts";
import {
  type LedgerPick,
  type PanelContext,
  type PanelDeps,
  panelEls,
  type Selection,
} from "./panels/context.ts";
import { renderFailure, renderFollowUp } from "./panels/failure.ts";
import { renderFiles } from "./panels/files.ts";
import { renderLedger } from "./panels/ledger.ts";
import { renderLedgerPreview, renderPreview } from "./panels/preview.ts";
import { mountPrograms } from "./panels/programs.ts";
import { renderQueue } from "./panels/queue.ts";
import { renderResult } from "./panels/result.ts";
import { renderStrip } from "./panels/strip.ts";
import { renderTask } from "./panels/task.ts";
import type { FileEntry } from "./result.ts";

export type { PanelDeps } from "./panels/context.ts";

export interface Panels {
  render(state: ClusterState): void;
  /** Select a task for the detail panel (null clears it). */
  selectTask(taskId: string | null): void;
  readonly selectedTask: string | null;
}

export function mountPanels(root: ParentNode, deps: PanelDeps): Panels {
  const els = panelEls(root);
  const selection: Selection = {
    task: null,
    file: deps.openFile ?? null,
    ledger: null,
    browsingRoot: deps.openRoot ?? null,
    pinned: deps.openFile != null || deps.openRoot != null,
    dismissedFailure: null,
  };
  const drawn = new Map<string, string>();
  const ctx: PanelContext = {
    els,
    cache: new BlobCache(deps.blobs, deps.rerender),
    deps,
    selection,
    last: null,
    changed(panel, signature) {
      if (drawn.get(panel) === signature) return false;
      drawn.set(panel, signature);
      return true;
    },
    selectTask(taskId) {
      selection.task = taskId;
      deps.rerender();
    },
    // A click on a file: the row's class and the preview change; the list stays as it is.
    selectFile(f: FileEntry | null) {
      selection.pinned = false;
      selection.file = f;
      for (const li of els.files.querySelectorAll<HTMLLIElement>("li.file"))
        li.classList.toggle(
          "selected",
          f !== null && li.dataset.hash === f.hash && li.dataset.path === f.path,
        );
      if (ctx.last) renderPreview(ctx, ctx.last);
    },
    selectLedger(row: LedgerPick | null) {
      selection.ledger = row;
      for (const tr of els.ledger.querySelectorAll<HTMLTableRowElement>("tbody tr"))
        tr.classList.toggle("selected", row !== null && tr.dataset.hash === row.hash);
      if (ctx.last) renderLedgerPreview(ctx, ctx.last);
    },
    browseRoot(rootHash) {
      selection.pinned = false;
      selection.browsingRoot = rootHash;
      selection.file = null;
      deps.rerender();
    },
  };
  const renderPrograms = mountPrograms(ctx);

  els.killExecution.onclick = () => {
    const exec = ctx.last?.execution;
    if (exec) deps.send({ t: "killExecution", executionId: exec.executionId });
  };

  function render(state: ClusterState): void {
    const changedExecution = ctx.last?.execution?.executionId !== state.execution?.executionId;
    if (changedExecution) {
      if (!selection.pinned) {
        selection.browsingRoot = null;
        selection.file = null;
      }
      selection.task = null;
    }
    ctx.last = state;
    renderPrograms(state);
    renderQueue(ctx, state);
    renderStrip(ctx, state);
    renderFailure(ctx, state);
    renderFollowUp(ctx, state);
    renderResult(ctx, state);
    renderFiles(ctx, state);
    renderTask(ctx, state);
    renderLedger(ctx, state);
    renderLedgerPreview(ctx, state);
  }

  return {
    render,
    selectTask: ctx.selectTask,
    get selectedTask() {
      return selection.task;
    },
  };
}
