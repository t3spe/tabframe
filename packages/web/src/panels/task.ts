// The task detail: the selected task's facts, every attempt the dashboard saw, and its log.
import type { AttemptRecord, ClusterState } from "../cluster-state.ts";
import { el } from "../dom.ts";
import { fmtTime, short } from "../format.ts";
import { TEXT_PREVIEW_BYTES } from "../result.ts";
import type { PanelContext } from "./context.ts";

export function renderTask(ctx: PanelContext, state: ClusterState): void {
  const { els, cache, selection } = ctx;
  const task = selection.task ? state.tasks.get(selection.task) : undefined;
  if (!task && selection.task && state.execution) selection.task = null; // the stage moved on
  if (!ctx.changed("task", JSON.stringify([selection.task, task, cache.version]))) return;
  els.taskDetail.hidden = !task;
  els.taskDetail.replaceChildren();
  if (!task) return;
  const head = el("div", "task-head");
  head.append(
    el("b", "mono", task.taskId),
    el("span", "pill", task.status),
    el(
      "span",
      "muted",
      `${task.kind} · stage ${task.stage}${task.index >= 0 ? ` · index ${task.index}` : ""}`,
    ),
  );
  const close = el("button", "small", "close");
  close.type = "button";
  close.onclick = () => ctx.selectTask(null);
  head.append(close);
  els.taskDetail.append(head);
  const facts = el("dl", "facts");
  const fact = (k: string, v: string, cls = "") => {
    facts.append(el("dt", undefined, k));
    facts.append(el("dd", cls, v));
  };
  if (task.place) fact("place", `${task.place.x},${task.place.y} ${task.place.w}×${task.place.h}`);
  fact("attempts", String(task.attempts));
  fact("holders", task.holders.length ? task.holders.join(", ") : "none");
  if (task.output) fact("output", task.output, "mono");
  if (task.computeMs !== null) fact("compute", `${task.computeMs} ms`);
  if (task.contested) fact("contested", "results disagreed; recomputed");
  if (task.verified) fact("verified", "a twin agreed");
  if (task.failure) fact("failure", task.failure, "bad");
  els.taskDetail.append(facts);

  const table = el("table", "attempts");
  const thead = el("thead");
  const hr = el("tr");
  for (const h of ["#", "node", "kind", "outcome", "at", "ms"]) hr.append(el("th", undefined, h));
  thead.append(hr);
  table.append(thead);
  const tbody = el("tbody");
  const rows: AttemptRecord[] = task.history;
  for (const a of rows) {
    const tr = el("tr", `outcome-${a.outcome}`);
    tr.append(
      el("td", "num", String(a.attempt)),
      el("td", "mono", a.nodeId),
      el("td", undefined, a.speculative ? "twin" : "primary"),
      el("td", undefined, a.outcome + (a.fromSnapshot ? " (from snapshot)" : "")),
      el("td", "mono", fmtTime(a.at)),
      el("td", "num", a.computeMs === null ? "—" : String(a.computeMs)),
    );
    tbody.append(tr);
  }
  if (rows.length === 0) {
    const tr = el("tr");
    tr.append(el("td", "muted", "no attempts seen yet"));
    tbody.append(tr);
  }
  table.append(tbody);
  els.taskDetail.append(table);

  const logBox = el("div", "task-log");
  if (task.log === null) {
    logBox.append(
      el(
        "p",
        "muted small",
        task.status === "done"
          ? "log: not carried on the wire yet (the control plane keeps it; forwarding is a one-line core change)"
          : "log: appears when the task is done",
      ),
    );
  } else if ("text" in task.log) {
    logBox.append(el("div", "muted small", "log"), el("pre", "text-view", task.log.text));
  } else {
    const bytes = cache.get(task.log.hash);
    logBox.append(el("div", "muted small", `log · ${short(task.log.hash, 8)}`));
    if (bytes === "pending") logBox.append(el("p", "muted", "fetching…"));
    else if (bytes === "error" || bytes === null)
      logBox.append(el("p", "bad", "could not be fetched"));
    else
      logBox.append(
        el("pre", "text-view", new TextDecoder().decode(bytes.subarray(0, TEXT_PREVIEW_BYTES))),
      );
  }
  els.taskDetail.append(logBox);
}
