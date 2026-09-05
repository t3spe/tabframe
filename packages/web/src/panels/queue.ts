// The queue: what waits behind the running execution, with a drop button per entry.
import type { ClusterState } from "../cluster-state.ts";
import { el } from "../dom.ts";
import { ago } from "../format.ts";
import type { PanelContext } from "./context.ts";

export function renderQueue(ctx: PanelContext, state: ClusterState): void {
  const { els, deps } = ctx;
  const now = deps.now();
  const rows = state.queue.map((q, i) => ({
    head: `${i + 1}. ${q.programName} ${q.executionId} · ${q.human ? "person" : "loop"} · waiting `,
    queuedAt: q.queuedAt,
    executionId: q.executionId,
  }));
  // The rows are rebuilt when the queue changes; the ages tick in place, so a rebuild every second
  // does not take the focus from the drop button a person is about to press.
  if (ctx.changed("queue", JSON.stringify(rows.map((r) => [r.head, r.executionId])))) {
    els.queue.replaceChildren(
      ...rows.map((r) => {
        const li = el("li", "queue-row");
        const text = el("span", "mono", r.head);
        const age = el("span", "mono age", ago(r.queuedAt, now));
        age.dataset.queuedAt = String(r.queuedAt);
        text.append(age);
        li.append(text);
        const drop = el("button", "small", "drop");
        drop.type = "button";
        drop.title = "Remove this execution from the queue";
        drop.dataset.drop = r.executionId;
        drop.onclick = () => deps.send({ t: "killExecution", executionId: r.executionId });
        li.append(drop);
        return li;
      }),
    );
    if (rows.length === 0) els.queue.append(el("li", "muted", "empty"));
  }
  for (const age of els.queue.querySelectorAll<HTMLSpanElement>("span.age")) {
    const text = ago(Number(age.dataset.queuedAt), now);
    if (age.textContent !== text) age.textContent = text;
  }
}
