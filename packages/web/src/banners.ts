// Words for the states in which the dashboard is not simply watching a live control plane: what is
// happening and what the visitor can do about it (design §6.7, §6.8, §9.4). Pure, so the copy is
// unit-tested and the page only places it.
import type { MachineState } from "./observer.ts";
import type { MachineBanner } from "./state.ts";

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

export const fmtCountdown = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

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
