// The header's pills and the connection banner, the machine banner over the stage, the execution
// row with its eight counters. `setMachine` is the one place the connection state lands.

import type { Counters } from "@tabframe/protocol";
import { PROTOCOL_VERSION } from "@tabframe/protocol";
import type { ClusterState } from "./cluster-state.ts";
import {
  connectionCopy,
  LOOP_TITLES,
  loopLabel,
  machineCopy,
  ROTATING_DETAIL,
  stopTitle,
} from "./copy.ts";
import { $, el } from "./dom.ts";
import { fmtCountdown } from "./format.ts";
import type { MachineState } from "./observer.ts";
import {
  headerSlot,
  hostCount,
  loopState,
  machineBanner,
  planTask,
  progress,
  throughput,
} from "./selectors.ts";

/** The eight counters, in the order the chips show them. */
export const COUNTER_LABELS: readonly (keyof Counters)[] = [
  "pending",
  "assigned",
  "done",
  "failed",
  "reassigned",
  "speculated",
  "verified",
  "mismatched",
];

/** A control's tooltip: what it does, and — when it cannot apply now — why (rule R3). */
export function reasoned(control: HTMLElement, reason: string | null): string {
  if (!control.dataset.baseTitle) control.dataset.baseTitle = control.title;
  return reason ? `${control.dataset.baseTitle} — ${reason}` : control.dataset.baseTitle;
}

export interface HeaderDeps {
  /** Every control button; all are disabled while the machine is not live. */
  controls: HTMLButtonElement[];
  redundancy: HTMLInputElement;
  rerender(): void;
}

export interface Header {
  readonly machine: MachineState;
  setMachine(state: MachineState, detail?: string): void;
  render(state: ClusterState, now: number): void;
}

export function mountHeader(root: ParentNode, deps: HeaderDeps): Header {
  const els = {
    machine: $<HTMLSpanElement>("#machine", root),
    gen: $<HTMLSpanElement>("#gen", root),
    counts: $<HTMLSpanElement>("#counts", root),
    seq: $<HTMLSpanElement>("#seq", root),
    exec: $<HTMLSpanElement>("#exec", root),
    rate: $<HTMLSpanElement>("#rate", root),
    nextRotation: $<HTMLSpanElement>("#nextRotation", root),
    machineBanner: $<HTMLDivElement>("#machineBanner", root),
    banner: $<HTMLDivElement>("#banner", root),
    bannerTitle: $<HTMLElement>("#bannerTitle", root),
    bannerBody: $<HTMLSpanElement>("#bannerBody", root),
    bannerHint: $<HTMLSpanElement>("#bannerHint", root),
    loop: $<HTMLSpanElement>("#loop", root),
    stage: $<HTMLDivElement>("#stage", root),
    table: $<HTMLTableElement>("#nodes", root),
    stop: $<HTMLButtonElement>("#stop", root),
    start: $<HTMLButtonElement>("#start", root),
    resume: $<HTMLButtonElement>("#resume", root),
    execName: $<HTMLSpanElement>("#execName", root),
    execDetail: $<HTMLSpanElement>("#execDetail", root),
    progressFill: $<HTMLDivElement>("#progressFill", root),
    progressText: $<HTMLSpanElement>("#progressText", root),
    counters: $<HTMLDivElement>("#counters", root),
  };
  let machine: MachineState = "connecting";

  function setMachine(state: MachineState, detail?: string): void {
    machine = state;
    els.machine.textContent = detail ? `${state} · ${detail}` : state;
    els.machine.className = `pill ${state === "live" ? "live" : state === "off" || state === "outdated" ? "off" : "wait"}`;
    els.banner.dataset.state = state;
    if (state === "live") {
      els.banner.hidden = true;
      els.stage.hidden = false;
      els.table.hidden = false;
    } else {
      // A reconnect after a rotation keeps the picture: the render continues on the new generation.
      const rotating = state === "connecting" && detail === ROTATING_DETAIL;
      els.stage.hidden = !rotating;
      els.table.hidden = !rotating;
      els.banner.hidden = false;
      const copy = connectionCopy(state, detail);
      els.bannerTitle.textContent = copy.title;
      els.bannerBody.textContent = copy.body;
      els.bannerHint.textContent = copy.hint;
      if (state === "outdated") reloadOnceForOutdated();
    }
    for (const button of deps.controls) {
      button.disabled = state !== "live";
      button.title = reasoned(button, state === "live" ? null : "not connected yet");
    }
    deps.redundancy.disabled = state !== "live";
    deps.rerender();
  }

  // One reload, not a loop: a stale bundle the cache keeps serving would reload into itself every
  // second and a half; after one try the banner asks for a hard refresh.
  function reloadOnceForOutdated(): void {
    let reloaded = false;
    try {
      reloaded = sessionStorage.getItem("tabframe-reloaded") === PROTOCOL_VERSION.toString();
      if (!reloaded) sessionStorage.setItem("tabframe-reloaded", PROTOCOL_VERSION.toString());
    } catch {
      // storage may be off; reload once anyway
    }
    if (!reloaded) setTimeout(() => location.reload(), 1_500);
    else
      els.bannerHint.textContent =
        "Reloaded once already: hard-refresh this page (Shift+reload) to fetch the current bundle.";
  }

  function render(state: ClusterState, now: number): void {
    const exec = state.execution;
    const prog = progress(state);
    els.gen.textContent = `gen ${state.generation ?? "—"}`;
    els.seq.textContent = `seq ${state.seq}`;
    els.counts.textContent = `${state.nodes.size} nodes · ${hostCount(state)} hosts`;
    // The execution pill is about the execution; the loop pill is about the loop.
    els.exec.textContent = exec
      ? `${exec.programName} · ${exec.phase === "running" ? exec.stageName || `stage ${exec.stage}` : exec.phase} · ${prog.done}/${prog.total}`
      : "idle";
    els.exec.className = `pill ${exec?.phase === "failed" ? "off" : exec ? "live" : ""}`;
    const loop = loopState(state);
    els.loop.textContent = loopLabel(state);
    els.loop.dataset.loop = loop;
    els.loop.title = LOOP_TITLES[loop];
    // The header's one slot means "what you can do to the machine right now" (rule R3).
    const slot = headerSlot(state);
    els.stop.hidden = slot !== "stop";
    els.start.hidden = slot !== "start";
    els.resume.hidden = slot !== "resume";
    els.stop.dataset.baseTitle = stopTitle(state);
    els.stop.title = reasoned(els.stop, machine === "live" ? null : "not connected yet");
    els.rate.textContent = `${throughput(state, now).toFixed(1)} tasks/s`;
    const due = state.machine?.nextRotationAt ?? null;
    els.nextRotation.hidden = due === null;
    if (due !== null) {
      const minutes = Math.ceil((due - now) / 60_000);
      els.nextRotation.textContent = minutes > 0 ? `rotation in ${minutes} min` : "rotation due";
    }
    renderMachineBanner(state, now);
    renderExecution(state);
  }

  /** The banner over the stage: a rotation with its countdown, the machine going to or being asleep. */
  function renderMachineBanner(state: ClusterState, now: number): void {
    const banner = machineBanner(state, now);
    const box = els.machineBanner;
    box.hidden = !banner;
    if (!banner) {
      box.replaceChildren();
      delete box.dataset.kind;
      delete box.dataset.next;
      return;
    }
    const copy = machineCopy(banner);
    box.dataset.kind = banner.kind;
    const title = el("strong");
    const body = el("span");
    const hint = el("span", "muted");
    if (banner.kind === "rotating") {
      box.dataset.next = String(banner.next);
      const gen = el("b");
      gen.id = "rotationGeneration";
      gen.textContent = String(banner.next);
      title.append("Control plane rotating to generation ", gen, ".");
      const countdown = el("b");
      countdown.id = "rotationCountdown";
      countdown.textContent = fmtCountdown(banner.msLeft);
      body.append(" Reconnecting in ", countdown, `. ${copy.body}`);
    } else {
      delete box.dataset.next;
      title.textContent = copy.title;
      body.textContent = ` ${copy.body}`;
    }
    hint.textContent = ` ${copy.hint}`;
    box.replaceChildren(title, body, hint);
  }

  function renderExecution(state: ClusterState): void {
    const exec = state.execution;
    const prog = progress(state);
    if (!exec) {
      els.execName.textContent = "No execution";
      els.execDetail.textContent = state.queue.length
        ? "waiting for the queue"
        : "the machine idles until a program is queued";
      els.execDetail.className = "muted";
      els.progressFill.style.width = "0%";
      els.progressText.textContent = "";
      // The counters keep their slots while nothing runs: eight chips, dashes for numbers.
      els.counters.replaceChildren(
        ...COUNTER_LABELS.map((label) => {
          const chip = el("span", "chip");
          chip.dataset.counter = label;
          chip.append(el("b", undefined, "—"), ` ${label}`);
          return chip;
        }),
      );
      return;
    }
    els.execName.textContent = `${exec.programName} ${exec.executionId}${exec.human ? " · launched by a person" : ""}`;
    const plan = planTask(state);
    const detail =
      exec.phase === "failed"
        ? `failed: ${exec.failure ?? exec.status}`
        : exec.phase === "done"
          ? `done${exec.root ? ` · root ${exec.root.slice(0, 12)}…` : ""}${exec.followUp ? " · follow-up offered" : ""}`
          : exec.phase === "planning"
            ? `planning stage ${exec.stage}${plan ? ` on ${plan.holders.join(", ") || "…"}` : ""}`
            : exec.phase === "folding"
              ? `folding stage ${exec.stage}`
              : `stage ${exec.stage} ${exec.stageName} · ${exec.view}${exec.canvas ? ` ${exec.canvas.w}×${exec.canvas.h}` : ""}`;
    const budget = exec.budget
      ? ` · budget ${(exec.budget.used / 1000).toFixed(0)}/${(exec.budget.cap / 1000).toFixed(0)} s`
      : "";
    els.execDetail.textContent = detail + budget;
    els.execDetail.className = exec.phase === "failed" ? "bad" : "muted";
    els.progressFill.style.width = prog.total ? `${(100 * prog.done) / prog.total}%` : "0%";
    els.progressText.textContent = `${prog.done}/${prog.total}`;
    // Eight chips updated in place, not rebuilt sixty times a second (rule R5).
    if (els.counters.childElementCount !== COUNTER_LABELS.length) {
      els.counters.replaceChildren(
        ...COUNTER_LABELS.map((label) => {
          const chip = el("span", "chip");
          chip.dataset.counter = label;
          chip.append(el("b"), ` ${label}`);
          return chip;
        }),
      );
    }
    COUNTER_LABELS.forEach((label, i) => {
      const value = exec.counters[label];
      const chip = els.counters.children[i] as HTMLElement;
      const num = chip.firstElementChild as HTMLElement;
      const text = String(value);
      if (num.textContent !== text) num.textContent = text;
      const cls = `chip${value > 0 && (label === "failed" || label === "mismatched") ? " chip-bad" : ""}`;
      if (chip.className !== cls) chip.className = cls;
    });
  }

  return {
    get machine() {
      return machine;
    },
    setMachine,
    render,
  };
}
