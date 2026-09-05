// One renderer for both preview boxes (the files tab's and the ledger tab's): a head with the
// name, size, hash, and a small "raw ↗" link to the store, then the bytes rendered by kind. The box
// is always there; empty, it explains itself.
import type { ClusterState, ExecutionState } from "../cluster-state.ts";
import { el } from "../dom.ts";
import { fmtBytes, short } from "../format.ts";
import { type Preview, previewOf } from "../result.ts";
import type { PanelContext } from "./context.ts";
import { barsList } from "./result.ts";

export function renderPreview(ctx: PanelContext, state: ClusterState): void {
  const f = ctx.selection.file;
  const sig = JSON.stringify([
    f?.hash,
    f?.path,
    f ? ctx.cache.get(f.hash) !== "pending" : null,
    ctx.cache.version,
  ]);
  if (!ctx.changed("preview", sig)) return;
  renderBytesInto(
    ctx,
    ctx.els.filePreview,
    f ? { hash: f.hash, label: f.path, size: f.size } : null,
    state,
    "Click a file to see its bytes here: a bar chart, text, a tile, a manifest, or the raw bytes.",
  );
}

export function renderLedgerPreview(ctx: PanelContext, state: ClusterState): void {
  const r = ctx.selection.ledger;
  const sig = JSON.stringify([
    r?.hash,
    r ? ctx.cache.get(r.hash) !== "pending" : null,
    ctx.cache.version,
  ]);
  if (!ctx.changed("ledgerPreview", sig)) return;
  renderBytesInto(
    ctx,
    ctx.els.ledgerPreview,
    r ? { hash: r.hash, label: `task ${r.taskId}`, size: r.size, taskId: r.taskId } : null,
    state,
    "Click a row to see the task's bytes here: a tile, a payload, text, or the raw bytes.",
  );
}

function renderBytesInto(
  ctx: PanelContext,
  box: HTMLElement,
  target: { hash: string; label: string; size: number | null; taskId?: string } | null,
  state: ClusterState,
  placeholder: string,
): void {
  box.hidden = false;
  box.replaceChildren();
  if (!target) {
    box.append(el("p", "muted small placeholder", placeholder));
    return;
  }
  const head = el(
    "div",
    "muted small mono",
    `${target.label}${target.size !== null ? ` · ${fmtBytes(target.size)}` : ""} · ${target.hash}`,
  );
  const store = ctx.deps.storeBase();
  if (store) {
    const raw = el("a", "mono raw", " raw ↗");
    raw.href = `${store.replace(/\/$/, "")}/${target.hash}`;
    raw.target = "_blank";
    raw.rel = "noreferrer";
    raw.title = "the bytes as the store holds them, by hash (your browser will save the file)";
    head.append(raw);
  }
  box.append(head);
  const bytes = ctx.cache.get(target.hash);
  if (bytes === "pending") return void box.append(el("p", "muted", "fetching…"));
  if (bytes === "error" || bytes === null)
    return void box.append(el("p", "bad", "could not be fetched"));
  const task = target.taskId ? state.tasks.get(target.taskId) : undefined;
  const tile = task?.place
    ? { w: task.place.w, h: task.place.h }
    : tileHint(state.execution, state);
  box.append(previewNode(previewOf(bytes, tile), bytes));
}

/** The tile size RGBA bytes are read at, from any placed task of a tiles execution. */
export function tileHint(
  exec: ExecutionState | null,
  state: ClusterState,
): { w: number; h: number } | null {
  if (exec?.view !== "tiles") return null;
  for (const t of state.tasks.values()) if (t.place) return { w: t.place.w, h: t.place.h };
  return { w: 64, h: 64 };
}

export function previewNode(p: Preview, bytes: Uint8Array): HTMLElement {
  switch (p.kind) {
    case "bars":
      return barsList(p.bars, "preview");
    case "text": {
      const pre = el("pre", "text-view", p.text);
      if (p.truncated) pre.append(`\n… (${fmtBytes(bytes.length)} in all)`);
      return pre;
    }
    case "manifest": {
      const list = el("ul", "plain files");
      for (const f of p.files)
        list.append(el("li", "mono", `${f.path} · ${fmtBytes(f.size)} · ${short(f.hash, 8)}`));
      return list;
    }
    case "image": {
      const canvas = el("canvas", "tile-preview");
      canvas.width = p.w;
      canvas.height = p.h;
      const c = canvas.getContext("2d");
      if (c) {
        const pixels = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        c.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, p.w, p.h), 0, 0);
      }
      canvas.title = `${p.w}×${p.h} RGBA`;
      return canvas;
    }
    default:
      return el("pre", "text-view mono", `${p.head}${bytes.length > 64 ? " …" : ""}`);
  }
}
