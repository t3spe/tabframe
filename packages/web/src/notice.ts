// The short-lived line under the header: a control's echo, or why a click went nowhere. One timer,
// so a second notice replaces the first instead of racing it.
import type { ClusterState } from "./cluster-state.ts";

/** How long after this page issued a control its echo is still taken as the answer. */
const OWN_CONTROL_WINDOW_MS = 10_000;
const ECHO_MS = 5_000;

export interface Notice {
  /** The transient text, or null when the sentence of state should show instead. */
  readonly current: string | null;
  /** Show `text` for `ms`; the caller renders now, the timer renders again when it clears. */
  show(text: string, ms: number): void;
  /** This page just issued a control: the machine's echo of it will show for a few seconds. */
  issued(): void;
  /** The newest control line, if this page issued it within the window and has not shown it yet. */
  echo(state: ClusterState): void;
}

export function createNotice(rerender: () => void, now: () => number = Date.now): Notice {
  let current: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let issuedAt = 0;
  let noticedSeq = 0;
  const show = (text: string, ms: number): void => {
    current = text;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      current = null;
      rerender();
    }, ms);
  };
  return {
    get current() {
      return current;
    },
    show,
    issued() {
      issuedAt = now();
    },
    echo(state) {
      if (now() - issuedAt > OWN_CONTROL_WINDOW_MS) return;
      const last = state.activity.at(-1);
      if (last?.kind !== "control" || last.seq <= noticedSeq) return;
      noticedSeq = last.seq;
      show(last.text, ECHO_MS);
    },
  };
}
