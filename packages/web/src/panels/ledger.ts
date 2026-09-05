// The ledger panel makes the point the architecture rests on: the control plane holds hashes,
// never bytes. Each settled task shows its output hash, the size when it is known, and where the
// bytes actually live.
import type { ClusterState, ExecutionState } from "../cluster-state.ts";
import { el, focusedDatum, refocus } from "../dom.ts";
import { fmtBytes } from "../format.ts";
import { listFiles, parseManifest } from "../result.ts";
import { ledgerRows } from "../selectors.ts";
import type { PanelContext } from "./context.ts";

/** Sizes the folded manifest knows, by hash, once the execution's root has been fetched. */
function manifestSizes(ctx: PanelContext, exec: ExecutionState | null): Map<string, number> {
  const out = new Map<string, number>();
  if (!exec?.root) return out;
  const bytes = ctx.cache.get(exec.root);
  if (bytes === "pending" || bytes === "error" || bytes === null) return out;
  try {
    for (const f of listFiles(parseManifest(bytes))) out.set(f.hash, f.size);
  } catch {
    /* not a manifest: nothing to size */
  }
  return out;
}

export function renderLedger(ctx: PanelContext, state: ClusterState): void {
  const { els, cache, deps, selection } = ctx;
  const exec = state.execution;
  // The dashboard keeps the newest eight; the ledger's own tab shows every settled task.
  const rows = ledgerRows(state, deps.panelMode === "ledger" ? Number.POSITIVE_INFINITY : 8);
  const store = deps.storeBase();
  // The signature is what changes when rows change — not every row: on the ledger tab that would
  // be thousands of rows serialised per frame.
  const newest = rows[0];
  const sig = JSON.stringify([
    exec?.executionId,
    exec?.stage,
    rows.length,
    newest?.taskId,
    newest?.output,
    newest?.verified,
    exec?.counters.verified,
    exec?.counters.mismatched,
    store,
    cache.version,
  ]);
  if (!ctx.changed("ledger", sig)) return;
  const sizes = manifestSizes(ctx, exec);
  let settled = 0;
  let bytes = 0;
  for (const t of state.tasks.values()) {
    if (t.status !== "done") continue;
    settled++;
    bytes += t.place ? t.place.w * t.place.h * 4 : (sizes.get(t.output ?? "") ?? 0);
  }
  els.ledgerSummary.textContent = exec
    ? `${settled} settled ${settled === 1 ? "task" : "tasks"} · ${fmtBytes(bytes)} in the store · hashes, not bytes`
    : "hashes, not bytes — nothing settled yet";
  els.ledgerNote.textContent = exec
    ? `The control plane holds hashes, not bytes: for each of the ${settled} settled ${settled === 1 ? "task" : "tasks"} of stage ${exec.stage} it keeps a 64-hex output hash; the bytes live in ${store ? "the store behind the CDN" : "this page's demo store"} and are fetched by hash. The newest ${Math.min(rows.length, 8) || ""} settled:`
    : "The control plane holds hashes, not bytes. No execution is running, so there is nothing settled to list.";
  const focusedTask = focusedDatum(els.ledger, "task");
  els.ledger.replaceChildren(
    ...rows.map((r) => {
      const tr = el("tr");
      tr.dataset.task = r.taskId;
      tr.dataset.hash = r.output;
      const size = r.size ?? sizes.get(r.output) ?? null;
      if (size !== null) tr.dataset.size = String(size);
      // The whole hash and the whole address: this is the point of the panel.
      const hash = el("td", "mono hash", r.output);
      hash.title = r.output;
      const where = el("td");
      if (store) {
        // The address as text; the small link is the download, the row is the view.
        const href = `${store.replace(/\/$/, "")}/${r.output}`;
        where.append(el("span", "mono", href), " ");
        const a = el("a", "mono raw", "raw ↗");
        a.href = href;
        a.target = "_blank";
        a.rel = "noreferrer";
        a.title = "the bytes as the store holds them (your browser will save the file)";
        a.onclick = (ev) => ev.stopPropagation();
        where.append(a);
      } else {
        const here = el("span", "muted", "demo store");
        here.title = "this page's in-memory store; nothing is on the network";
        where.append(here);
      }
      tr.classList.toggle("selected", selection.ledger?.hash === r.output);
      tr.title = "click to see the task's bytes in the preview";
      tr.tabIndex = 0;
      tr.setAttribute("role", "button");
      tr.onkeydown = (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          tr.click();
        }
      };
      tr.onclick = () =>
        ctx.selectLedger(
          selection.ledger?.hash === r.output ? null : { hash: r.output, taskId: r.taskId, size },
        );
      tr.append(
        el("td", "mono", r.taskId + (r.verified ? " ✓" : "")),
        el("td", "mono", r.nodeId ?? "—"),
        hash,
        el("td", "num", size === null ? "—" : fmtBytes(size)),
        where,
      );
      return tr;
    }),
  );
  if (rows.length === 0) {
    const tr = el("tr");
    const td = el("td", "muted", exec ? "nothing settled yet" : "—");
    td.colSpan = 5;
    tr.append(td);
    els.ledger.append(tr);
  }
  refocus(els.ledger, "task", focusedTask);
}
