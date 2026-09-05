// `?demo=1`: a scripted control plane inside the page. It feeds the reducer the same messages the
// wire carries (snapshot, executions, stages, task events, controls, a rotation) and serves real
// Mandelbrot tiles from an in-memory store under their true hashes, so the dashboard's fetch and
// re-hash path runs unchanged. Nothing here touches the network.
//
// The machine cycles through three programs: a Mandelbrot frame (a straggler, a liar, a scrambled
// tile, kill half, a rotation), a word count (three stages, a `bars` result, a filesystem to
// browse, logs on the tasks), and a broken program whose planner traps (the failure banner), after
// which the machine goes to sleep and wakes for the next frame (the sleep banner).
import { type DemoHandle, DemoMachine, type DemoOptions } from "./demo/machine.ts";
import { createStory } from "./demo/story.ts";

export {
  centreOut,
  DEMO_CANVAS,
  DEMO_CYCLE,
  DEMO_PROGRAMS,
  DEMO_SCRAMBLED_AT,
  DEMO_SLEEP_REASON,
  DEMO_TASKS,
  DEMO_TILE,
  type DemoProgram,
  mulberry32,
  renderTile,
} from "./demo/content.ts";
export type { DemoClock, DemoHandle, DemoOptions, DemoTimers } from "./demo/machine.ts";

/** Start the scripted machine; the handle takes controls and pauses or resumes it. */
export function startDemo(opts: DemoOptions): DemoHandle {
  const machine = new DemoMachine(opts);
  machine.story = createStory(machine, opts.holdAfterFirst ?? false);
  machine.boot();
  return machine.handle();
}
