// The result view of a `bars` or `text` program: the single output of the last stage, fetched by
// hash and decoded; while the execution runs, a line saying where it is.
import type { ClusterState } from "../cluster-state.ts";
import { el } from "../dom.ts";
import { fmtBytes, fmtValue } from "../format.ts";
import {
  barRows,
  type FileEntry,
  finalOutput,
  parseManifest,
  readBars,
  TEXT_PREVIEW_BYTES,
} from "../result.ts";
import type { PanelContext } from "./context.ts";

export function renderResult(ctx: PanelContext, state: ClusterState): void {
  const { els, cache } = ctx;
  const exec = state.execution;
  const current = exec?.stages[exec.stage];
  const sig = JSON.stringify([
    exec?.executionId,
    exec?.view,
    exec?.phase,
    exec?.root,
    exec?.failure,
    exec?.stage,
    current,
    cache.version,
  ]);
  if (!ctx.changed("result", sig)) return;
  if (!exec || exec.view === "tiles") {
    els.result.hidden = true;
    els.result.replaceChildren();
    return;
  }
  els.result.hidden = false;
  els.result.dataset.view = exec.view;
  if (exec.phase === "failed") {
    els.result.replaceChildren(
      el("p", "muted", "no result · the execution failed; the box above says why"),
    );
    return;
  }
  if (exec.phase === "stopped") {
    els.result.replaceChildren(
      el("p", "muted", "no result · a person stopped the execution before its last stage folded"),
    );
    return;
  }
  if (!exec.root || exec.phase !== "done") {
    els.result.replaceChildren(
      el(
        "p",
        "muted",
        exec.phase === "planning"
          ? `${exec.view} view: planning stage ${exec.stage}; the result appears when the last stage folds.`
          : `${exec.view} view: stage ${exec.stage}${current?.name ? ` ${current.name}` : ""} in progress${current ? `, ${current.done}/${current.taskCount}` : ""}; the result appears when the last stage folds.`,
      ),
    );
    return;
  }
  const manifest = cache.get(exec.root);
  if (manifest === "pending") {
    els.result.replaceChildren(el("p", "muted", "fetching the result…"));
    return;
  }
  if (manifest === "error" || manifest === null) {
    els.result.replaceChildren(el("p", "bad", "the result's manifest could not be fetched"));
    return;
  }
  let final: FileEntry | null;
  try {
    final = finalOutput(parseManifest(manifest));
  } catch {
    els.result.replaceChildren(el("p", "bad", "the root is not a filesystem manifest"));
    return;
  }
  if (!final) {
    els.result.replaceChildren(
      el("p", "muted", "the last stage produced several outputs; see the files panel"),
    );
    return;
  }
  const bytes = cache.get(final.hash);
  if (bytes === "pending") {
    els.result.replaceChildren(el("p", "muted", `fetching ${final.path}…`));
    return;
  }
  if (bytes === "error" || bytes === null) {
    els.result.replaceChildren(el("p", "bad", `${final.path} could not be fetched`));
    return;
  }
  const head = el("div", "result-head muted small", `${final.path} · ${fmtBytes(final.size)}`);
  if (exec.view === "bars") {
    const r = readBars(bytes);
    if (!r.ok) {
      els.result.replaceChildren(head, el("p", "bad", `not a bars payload: ${r.error}`));
      return;
    }
    els.result.replaceChildren(head, barsList(r.bars, exec.view));
    return;
  }
  const text = new TextDecoder().decode(bytes.subarray(0, TEXT_PREVIEW_BYTES));
  els.result.replaceChildren(head, el("pre", "text-view", text));
  if (bytes.length > TEXT_PREVIEW_BYTES)
    els.result.append(el("p", "muted small", `showing the first ${fmtBytes(TEXT_PREVIEW_BYTES)}`));
}

/** A horizontal bar list, longest first, scaled to the widest. */
export function barsList(bars: Parameters<typeof barRows>[0], view: string): HTMLElement {
  const list = el("ol", "bars");
  list.dataset.view = view;
  for (const b of barRows(bars)) {
    const li = el("li", "bar-row");
    li.dataset.label = b.label;
    const label = el("span", "bar-label", b.label);
    const track = el("span", "bar-track");
    const fill = el("span", "bar-fill");
    fill.style.width = `${Math.max(0.5, b.fraction * 100).toFixed(1)}%`;
    track.append(fill);
    const value = el("span", "bar-value mono", fmtValue(b.value));
    li.append(label, track, value);
    list.append(li);
  }
  if (bars.length > 40) list.append(el("li", "muted small", `… and ${bars.length - 40} more`));
  return list;
}
