// The stage strip: every stage seen so far with its tally and root, and the planning step in between.
import type { ClusterState } from "../cluster-state.ts";
import { el } from "../dom.ts";
import { short } from "../format.ts";
import { stageStrip } from "../selectors.ts";
import type { PanelContext } from "./context.ts";

export function renderStrip(ctx: PanelContext, state: ClusterState): void {
  const entries = stageStrip(state);
  if (!ctx.changed("strip", JSON.stringify(entries))) return;
  const { strip } = ctx.els;
  strip.hidden = entries.length === 0;
  strip.replaceChildren(
    ...entries.map((e) => {
      if (e.kind === "plan") {
        const chip = el("span", "stage stage-plan");
        chip.dataset.stage = String(e.stage);
        chip.append(
          el("b", undefined, `plan ${e.stage}`),
          el("span", "muted", e.holders.length ? `on ${e.holders.join(", ")}` : "waiting"),
        );
        return chip;
      }
      const s = e.stage;
      const chip = el("span", `stage stage-${s.status}${e.current ? " stage-current" : ""}`);
      chip.dataset.stage = String(s.stage);
      const title = s.known ? `${s.stage} ${s.name}` : `${s.stage}`;
      chip.append(el("b", undefined, title));
      const tally = s.known
        ? `${s.done}/${s.taskCount}${s.failed ? ` · ${s.failed} failed` : ""}`
        : "before this page joined";
      chip.append(el("span", "muted", tally));
      if (s.root) {
        const root = s.root;
        const link = el("a", "mono", short(root, 8));
        link.href = "#filesPanel";
        link.title = `browse the filesystem after stage ${s.stage}: ${root}`;
        link.onclick = (ev) => {
          ev.preventDefault();
          ctx.browseRoot(root);
        };
        chip.append(link);
      }
      return chip;
    }),
  );
}
