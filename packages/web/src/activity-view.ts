// The flash log beside the grid and the activity list: both redraw only when their lines changed.
import type { ClusterState } from "./cluster-state.ts";
import { PULSE_TEXT } from "./copy.ts";
import { el } from "./dom.ts";
import { fmtTime } from "./format.ts";
import { isFlashing, latestControl, visibleActivity } from "./selectors.ts";

/** The last flashes as words, newest first; a row that is still flashing is marked live. */
export class PulsesView {
  private readonly list: HTMLUListElement;
  private drawn = "";

  constructor(list: HTMLUListElement) {
    this.list = list;
  }

  render(state: ClusterState, now: number): void {
    const rows = state.pulses.slice(-6).reverse();
    const sig = rows.map((p) => `${p.seq}:${p.taskId}:${isFlashing(p.at, now)}`).join(" ");
    if (sig === this.drawn) return;
    this.drawn = sig;
    this.list.hidden = rows.length === 0;
    this.list.replaceChildren(
      ...rows.map((p) => {
        const li = el("li", `pulse pulse-${p.kind}${isFlashing(p.at, now) ? " pulse-live" : ""}`);
        li.dataset.kind = p.kind;
        li.dataset.task = p.taskId;
        li.append(el("span", "muted", fmtTime(p.at)), ` ${PULSE_TEXT[p.kind](p)}`);
        return li;
      }),
    );
  }
}

/** The activity list with its one-line summary; a panel tab shows every line, the dashboard a snippet. */
export class ActivityView {
  private readonly list: HTMLUListElement;
  private readonly summary: HTMLElement;
  private readonly all: boolean;
  private drawn = "";

  constructor(list: HTMLUListElement, summary: HTMLElement, all: boolean) {
    this.list = list;
    this.summary = summary;
    this.all = all;
  }

  render(state: ClusterState, now: number): void {
    const lastAct = state.activity.at(-1);
    this.summary.textContent = lastAct
      ? `${state.activity.length} lines · last: ${fmtTime(lastAct.at)} ${lastAct.text}`
      : "nothing yet";
    const lastControl = latestControl(state, now);
    const sig = `${state.activity.length}:${lastAct?.seq ?? 0}:${lastAct?.at ?? 0}:${lastControl?.at ?? 0}`;
    if (sig === this.drawn) return;
    this.drawn = sig;
    this.list.replaceChildren(
      ...visibleActivity(state, now, this.all)
        .reverse()
        .map((a) => {
          const li = el("li", `act act-${a.kind}`);
          li.append(el("span", "muted", fmtTime(a.at)), ` ${a.text}`);
          return li;
        }),
    );
  }
}
