// The page's words: what is happening and what the visitor can do about it (design §6.7, §6.8,
// §9.4; rule R1). Pure, so the copy is unit-tested and the views only place it.
import type { NodeView } from "@tabframe/protocol";
import { type ClusterState, isRunningPhase, type Pulse, type TaskColor } from "./cluster-state.ts";
import type { MachineState } from "./observer.ts";
import { type LoopState, loopState, type MachineBanner } from "./selectors.ts";

export interface Copy {
  title: string;
  body: string;
  /** What the visitor can do, or that there is nothing to do. */
  hint: string;
}

/** The detail the observer client attaches to `connecting` after a rotation closed its socket. */
export const ROTATING_DETAIL = "control plane rotating";

/** The full-page banner while there is no live observer socket. */
export function connectionCopy(state: Exclude<MachineState, "live">, detail?: string): Copy {
  switch (state) {
    case "off":
      return {
        title: "The machine is off.",
        body: "An operator turns it on with mise run up. This page asks the session every few seconds and connects on its own once the machine answers.",
        hint: "Meanwhile the demo (?demo=1) shows this dashboard driving a scripted cluster.",
      };
    case "starting":
      return {
        title: "Waking the machine…",
        body: "A fresh MicroVM is booting the control plane from its snapshot, which takes about a minute; the page connects as soon as it answers.",
        hint: "Nothing to do but keep this tab open. Tiles start landing once a node joins — this tab lends one unless it is only observing.",
      };
    case "full":
      return {
        title: "The machine is full.",
        body: "Fourteen tabs are connected already; the control plane holds sixteen connections and keeps two for its own rotation.",
        hint: "Close a tab, or wait: this page tries again in ten seconds.",
      };
    case "outdated":
      return {
        title: "This page is out of date.",
        body: detail
          ? `The machine said: ${detail}.`
          : "The machine speaks a newer protocol than this page was built for.",
        hint: "Reloading…",
      };
    default:
      return detail === ROTATING_DETAIL
        ? {
            title: "Control plane rotating…",
            body: "The hourly rotation handed the ledger to a fresh control plane; this page reconnects to the new generation in a moment and the render continues where it was.",
            hint: "Nothing to do: the generation pill changes when the page is back.",
          }
        : {
            title: "Connecting…",
            body:
              detail ??
              "Asking the session for the control plane's address; a sleeping machine wakes up when asked.",
            hint: "Nothing to do: the page keeps trying on its own.",
          };
  }
}

/** The banner over the stage while the machine is live but rotating, going to sleep, or asleep. */
export function machineCopy(banner: MachineBanner): Copy {
  switch (banner.kind) {
    case "rotating":
      return {
        title: `Control plane rotating to generation ${banner.next}.`,
        body: "Every hour the control plane hands its ledger — hashes, not bytes — to a fresh MicroVM; nodes reconnect after a jittered delay and the render carries on from the same ledger.",
        hint: "Nothing to do: watch the generation pill tick over.",
      };
    case "sleeping":
      return {
        title: "The machine is going to sleep.",
        body: `Reason: ${banner.reason}. It stops its cloud cores and snapshots the ledger; the automatic loop pauses while browser tabs keep their nodes.`,
        hint: "Any control, launch, or fresh visit wakes it again.",
      };
    default:
      return {
        title: "The machine is asleep.",
        body: banner.reason
          ? `It went to sleep after ${banner.reason}. Your visit wakes it: the cloud cores come back and the loop resumes.`
          : "Your visit wakes it: the cloud cores come back and the loop resumes.",
        hint: "Nothing to do: it takes a minute or so. Spawning a node here helps it along.",
      };
  }
}

/** What each colour means, in legend order; the page maps the keys to swatches. */
export const TASK_COLOR_LABELS: ReadonlyArray<[TaskColor, string]> = [
  ["pending", "pending"],
  ["assigned", "assigned"],
  ["speculated", "speculated twin"],
  ["released", "taken back, waiting"],
  ["done", "done"],
  ["verified", "verified by a twin"],
  ["mismatch", "mismatch, recomputing"],
  ["failed", "failed"],
];

/** The legend: every task colour, then the two overlays the grid draws on top of them. */
export const LEGEND: ReadonlyArray<[TaskColor | "flash" | "contested", string]> = [
  ...TASK_COLOR_LABELS,
  ["flash", "flash: just taken back, twinned, verified, or retracted"],
  ["contested", "contested: results disagreed"],
];

/** What a flash says in the pulse list. */
export const PULSE_TEXT: Record<Pulse["kind"], (p: Pulse) => string> = {
  released: (p) => `${p.taskId} taken back from ${p.nodeId}`,
  speculated: (p) => `${p.taskId} twin on ${p.nodeId}`,
  verified: (p) => `${p.taskId} verified by ${p.nodeId}`,
  mismatch: (p) => `${p.taskId} results disagree, ${p.nodeId} retracted`,
};

/** A node's kind in the page's words: the wire says `core` for a MicroVM, the page says where it runs. */
export function kindLabel(kind: NodeView["kind"]): string {
  return kind === "core" ? "cloud core" : "tab";
}

/** The loop pill's words: what the loop is doing and what changes it. */
export function loopLabel(state: ClusterState): string {
  switch (loopState(state)) {
    case "paused":
      return "loop · paused by the editor";
    case "held":
      return "loop · held by Stop";
    case "yielded":
      return "loop · yielded to you";
    default:
      return "loop · running";
  }
}

/** The loop pill's tooltip, by loop state. */
export const LOOP_TITLES: Record<LoopState, string> = {
  running: "The automatic loop renders frame after frame while someone watches",
  held: "A person pressed Stop: the loop launches nothing until Start; a launch of yours still runs at once",
  yielded: "Your launch ended: the result stays on the stage until Start or ten quiet minutes",
  paused:
    "An editor tab holds the machine: in-flight tasks finish, nothing new starts; closing it or launching resumes",
};

/** Stop's tooltip depends on what it would end. */
export function stopTitle(state: ClusterState): string {
  const exec = state.execution;
  if (exec && isRunningPhase(exec.phase))
    return `Ends ${exec.programName} ${exec.executionId}${exec.human ? " (a person's launch)" : ""} and holds the automatic loop until Start; a launch of yours still runs at once`;
  return "Holds the automatic loop before its next frame; Start lets it run again; a launch of yours still runs at once";
}

/**
 * One sentence of state, always (rule R1): what the machine is doing and why, in a visitor's
 * words. Null while the page is not connected — the connection banner speaks then.
 */
export function machineSentence(
  state: ClusterState,
  ctx: { live: boolean; demo: boolean; observe: boolean },
): string | null {
  if (!ctx.live) return null;
  const exec = state.execution;
  const loop = loopState(state);
  const nodes = `${state.nodes.size} ${state.nodes.size === 1 ? "node" : "nodes"}`;
  let core: string;
  if (loop === "paused")
    core =
      "paused · the editor tab is open · in-flight tasks finish, nothing new starts · closing it or launching resumes";
  else if (exec && isRunningPhase(exec.phase)) {
    const where = exec.phase === "running" ? exec.stageName || `stage ${exec.stage}` : exec.phase;
    core = exec.human
      ? `running your ${exec.programName} ${exec.executionId} · ${where} · ${nodes} · the loop waits behind it`
      : `${exec.view === "tiles" ? "rendering" : "running"} ${exec.programName} ${exec.executionId} · ${where} · ${nodes}`;
  } else if (loop === "held")
    core = "stopped by you · nothing runs until Start · a launch of yours still runs at once";
  else if (loop === "yielded") {
    const ended =
      exec?.phase === "done" ? "is done" : exec?.phase === "failed" ? "failed" : "was stopped";
    core = exec
      ? `your ${exec.programName} ${exec.executionId} ${ended} · the result stays · the loop waits for Start or ten quiet minutes`
      : "the loop yielded to you · Start hands it the stage back, or ten quiet minutes do";
  } else if (exec?.phase === "failed")
    core = exec.human
      ? `your ${exec.programName} ${exec.executionId} failed · the loop is free again`
      : `${exec.programName} ${exec.executionId} failed · the loop tries again in a moment`;
  else if (exec?.phase === "stopped")
    core = `${exec.programName} ${exec.executionId} was stopped · the loop is free again`;
  else if (state.queue.length > 0)
    core = `${state.queue.length} queued · the next one starts in a moment`;
  else core = "idle · the loop starts a frame when someone watches";
  const prefix = ctx.demo
    ? "demo · a scripted cluster inside this page, nothing is sent anywhere · "
    : ctx.observe
      ? "observing · this tab lends no cores · "
      : "";
  return prefix + core;
}
