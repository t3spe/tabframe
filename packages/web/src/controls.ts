// The controls a page can issue, as the vocabulary the panels, the demo, and the dashboard share.
import type { Control } from "@tabframe/protocol";

/** A control as the page issues it; the observer client stamps the version and generation. */
export type ControlRequest = Control extends infer C
  ? C extends { v: number; gen: number }
    ? Omit<C, "v" | "gen">
    : never
  : never;
