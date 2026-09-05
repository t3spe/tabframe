// The node table under the stage: every node the machine knows, this tab's own starred.
import type { NodeView } from "@tabframe/protocol";
import type { ClusterState } from "./cluster-state.ts";
import { kindLabel } from "./copy.ts";
import { fmtMs, fmtTime } from "./format.ts";
import { inFlightByNode, isFlashing } from "./selectors.ts";

/** The table changes slowly; four times a second is plenty at 256 rows. */
const TABLE_INTERVAL_MS = 250;

export class NodesTable {
  private readonly tbody: HTMLTableSectionElement;
  private renderedAt = 0;

  constructor(tbody: HTMLTableSectionElement) {
    this.tbody = tbody;
  }

  /** Redraw when due or when the node count moved; `invalidate()` makes the next render due. */
  render(state: ClusterState, now: number, mine: Set<string>): void {
    if (
      now - this.renderedAt < TABLE_INTERVAL_MS &&
      state.nodes.size === this.tbody.childElementCount
    )
      return;
    this.renderedAt = now;
    const inFlight = inFlightByNode(state);
    const victims = state.victims && isFlashing(state.victims.at, now) ? state.victims : null;
    const rows = [...state.nodes.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    this.tbody.replaceChildren(
      ...rows.map((n) =>
        row(
          n,
          mine.has(n.nodeId),
          inFlight.get(n.nodeId) ?? 0,
          victims?.nodeIds.includes(n.nodeId) ?? false,
          victims?.op ?? "",
        ),
      ),
    );
  }

  invalidate(): void {
    this.renderedAt = 0;
  }
}

function row(
  n: NodeView,
  mine: boolean,
  inFlight: number,
  hit: boolean,
  op: string,
): HTMLTableRowElement {
  const tr = document.createElement("tr");
  const cells = [
    n.nodeId + (mine ? " ★" : ""),
    n.hostId,
    kindLabel(n.kind),
    n.health,
    n.visible ? "yes" : "hidden",
    String(n.tasksDone),
    String(inFlight),
    fmtMs(n.lastTaskMs),
    fmtTime(n.joinedAt),
  ];
  cells.forEach((text, i) => {
    const td = document.createElement("td");
    td.textContent = text;
    if (i >= 5 && i <= 7) td.className = "num";
    if (i === 3) td.className = `health-${n.health}`;
    if (i === 0 && mine) td.className = "mine";
    tr.appendChild(td);
  });
  tr.dataset.nodeId = n.nodeId;
  if (hit) {
    tr.className = "hit";
    tr.title = op;
  }
  return tr;
}
