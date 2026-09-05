// Failure surfacing: the last failed execution until one succeeds, the running execution's
// warnings, the follow-up a finished launch offers, and the kill button's reason.
import { type ClusterState, isRunningPhase } from "../cluster-state.ts";
import { el } from "../dom.ts";
import { fmtTime } from "../format.ts";
import type { PanelContext } from "./context.ts";

export function renderFailure(ctx: PanelContext, state: ClusterState): void {
  const { els, deps, selection } = ctx;
  const f = state.lastFailure;
  const key = f ? `${f.executionId}:${f.reason}` : null;
  const warnings = state.execution?.warnings ?? [];
  if (!ctx.changed("failure", JSON.stringify([f, selection.dismissedFailure, warnings]))) return;
  if (!f || key === selection.dismissedFailure) {
    els.failure.hidden = true;
    els.failure.replaceChildren();
  } else {
    els.failure.hidden = false;
    const text = el("span");
    text.append(el("b", undefined, `${f.programName} ${f.executionId} failed`), ` — ${f.reason}`);
    const when = el("span", "muted", ` at ${fmtTime(f.at)}`);
    const dismiss = el("button", "small", "dismiss");
    dismiss.type = "button";
    dismiss.onclick = () => {
      selection.dismissedFailure = key;
      deps.rerender();
    };
    els.failure.replaceChildren(text, when, dismiss);
  }
  els.warnings.hidden = warnings.length === 0;
  els.warnings.replaceChildren(...warnings.map((w) => el("li", undefined, `warning: ${w}`)));
}

export function renderFollowUp(ctx: PanelContext, state: ClusterState): void {
  const { els, deps } = ctx;
  const exec = state.execution;
  const sig = JSON.stringify([exec?.executionId, exec?.phase, exec?.human, exec?.followUp]);
  if (!ctx.changed("followUp", sig)) return;
  const offered = exec && exec.phase === "done" && exec.human && exec.followUp;
  els.followUp.hidden = !offered;
  els.followUp.replaceChildren();
  // Kill execution stays where it is and says why when nothing runs (rule R3).
  const runningNow = !!exec && isRunningPhase(exec.phase);
  els.killExecution.hidden = false;
  els.killExecution.disabled = !runningNow;
  if (!els.killExecution.dataset.baseTitle)
    els.killExecution.dataset.baseTitle = els.killExecution.title;
  els.killExecution.title = runningNow
    ? (els.killExecution.dataset.baseTitle as string)
    : `${els.killExecution.dataset.baseTitle} — nothing is running`;
  if (!offered || !exec.followUp) return;
  const params = exec.followUp;
  const button = el("button", undefined, `run follow-up ${JSON.stringify(params)}`);
  button.type = "button";
  button.id = "runFollowUp";
  button.title = "The program suggested these params for its next run; nothing runs unless you ask";
  button.onclick = () => {
    button.disabled = true;
    deps.send({ t: "runFollowUp", executionId: exec.executionId });
  };
  els.followUp.append(
    button,
    el("span", "muted small", " — a person's follow-up is offered, never queued on its own"),
  );
}
