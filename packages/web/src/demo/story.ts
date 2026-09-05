// The demo's story: which program runs next, and the beats of the Mandelbrot frame — a straggler,
// a liar, a scrambled tile, kill half, a rotation — keyed by tiles done.
import type { ExecutionView } from "@tabframe/protocol";
import { canonicalStringify } from "@tabframe/protocol";
import {
  BROKEN,
  CORPUS_HEAD,
  DEMO_CANVAS,
  DEMO_CYCLE,
  DEMO_SLEEP_REASON,
  DEMO_TASKS,
  type DemoProgram,
  PRESETS,
  PROGRAM,
  utf8,
  WC_STAGES,
  WORDCOUNT,
} from "./content.ts";
import type { DemoMachine, Story } from "./machine.ts";

export function createStory(m: DemoMachine, holdAfterFirst: boolean): Story {
  let executionsEnded = 0;
  const beats = new Set<number>();

  const startNext = (force = false): void => {
    // Held by Stop until Start; a person's launch runs anyway.
    if (m.stopped && !force) return;
    // A machine that went to sleep wakes for the next execution; its snapshot says so.
    if (m.asleep) {
      m.asleep = false;
      m.snapshot();
    }
    m.program = DEMO_CYCLE[m.cycleAt % DEMO_CYCLE.length] as DemoProgram;
    m.cycleAt += 1;
    if (m.program === "mandelbrot") startFrame();
    else if (m.program === "wordcount") startWordcount();
    else startBroken();
  };

  const newExecution = (
    program: string,
    programName: string,
    view: ExecutionView["view"],
    human: boolean,
    params: Record<string, unknown>,
    extra: Partial<ExecutionView> = {},
  ): ExecutionView => ({
    executionId: `e${++m.executionCounter}`,
    program,
    programName,
    status: "running",
    human,
    view,
    params,
    stage: 0,
    stageName: "",
    taskCount: 0,
    canvas: null,
    root: null,
    counters: m.counters(),
    startedAt: m.vnow,
    ...extra,
  });

  const resetTally = (): void => {
    m.tally.reassigned = m.tally.speculated = m.tally.verified = m.tally.mismatched = 0;
  };

  const startFrame = (): void => {
    m.frame += 1;
    beats.clear();
    resetTally();
    const human = m.launchedByPerson; // a launch from the programs panel is the person's
    m.launchedByPerson = false;
    const execution = newExecution(
      PROGRAM,
      "mandelbrot",
      "tiles",
      human,
      { preset: m.frame % PRESETS.length, palette: "ocean" },
      { canvas: { ...DEMO_CANVAS } },
    );
    const { executionId } = execution;
    m.emit({
      t: "executionQueued",
      entry: { executionId, programName: "mandelbrot", human, queuedAt: m.vnow },
    });
    m.execution = execution;
    m.tasks = [];
    m.files = {};
    m.after(300, () => {
      if (!m.execution) return;
      m.emit({ t: "executionStarted", execution: { ...m.execution } });
      m.plan(0, () => {
        if (!m.execution) return;
        m.stageTasks(executionId, 0, DEMO_TASKS, true);
        m.execution = { ...m.execution, stageName: "render", taskCount: DEMO_TASKS };
        m.emit({
          t: "stageStarted",
          executionId,
          stage: 0,
          name: "render",
          taskCount: DEMO_TASKS,
          canvas: { ...DEMO_CANVAS },
          tasks: m.tasks.slice(0, 256).map((t) => m.taskView(t)),
        });
        m.fill();
      });
    });
  };

  const startWordcount = (): void => {
    resetTally();
    const execution = newExecution(WORDCOUNT, "wordcount", "bars", true, { k: 25, mapTasks: 8 });
    const { executionId } = execution;
    m.emit({
      t: "executionQueued",
      entry: { executionId, programName: "wordcount", human: true, queuedAt: m.vnow },
    });
    m.execution = execution;
    m.tasks = [];
    // The bundle's own files are the first root (design §5.4).
    Promise.all([
      m.put(utf8.encode("\0asm\x01\0\0\0 (demo module bytes)")),
      m.put(
        utf8.encode(
          JSON.stringify({
            name: "wordcount",
            view: "bars",
            defaultParams: { k: 25, mapTasks: 8 },
          }),
        ),
      ),
      m.put(utf8.encode(CORPUS_HEAD.repeat(6))),
    ])
      .then(async ([module, manifest, corpus]) => {
        m.files = {
          "/program.wasm": { hash: module, size: 34 },
          "/manifest.json": { hash: manifest, size: 62 },
          "/in/corpus.txt": { hash: corpus, size: CORPUS_HEAD.length * 6 },
        };
        const root = await m.put(utf8.encode(canonicalStringify({ version: 1, files: m.files })));
        if (!m.execution || m.execution.executionId !== executionId) return;
        m.execution = { ...m.execution, root };
        m.after(300, () => {
          if (!m.execution) return;
          m.emit({ t: "executionStarted", execution: { ...m.execution } });
          m.emit({
            t: "executionWarning",
            executionId,
            code: "expired-root",
            message: "the filesystem inherited from e38 is gone; starting from the bundle",
          });
          nextStage(executionId, 0);
        });
      })
      .catch((err) => m.fault(err));
  };

  const nextStage = (executionId: string, stage: number): void => {
    m.plan(stage, () => {
      if (!m.execution || m.execution.executionId !== executionId) return;
      const spec = WC_STAGES[stage];
      if (!spec) return;
      m.stageTasks(executionId, stage, spec.count, false);
      m.execution = { ...m.execution, stage, stageName: spec.name, taskCount: spec.count };
      m.emit({
        t: "stageStarted",
        executionId,
        stage,
        name: spec.name,
        taskCount: spec.count,
        canvas: null,
        tasks: m.tasks.map((t) => m.taskView(t)),
      });
      m.fill();
    });
  };

  const startBroken = (): void => {
    const execution = newExecution(BROKEN, "broken", "text", true, {}, { root: BROKEN });
    const { executionId } = execution;
    m.emit({
      t: "executionQueued",
      entry: { executionId, programName: "broken", human: true, queuedAt: m.vnow },
    });
    m.execution = execution;
    m.tasks = [];
    m.after(300, () => {
      if (!m.execution) return;
      m.emit({ t: "executionStarted", execution: { ...m.execution } });
      const planId = `t${++m.taskCounter}`;
      const planner = m.alive()[0];
      if (!planner) return;
      m.after(200, () =>
        m.emit({ t: "taskAssigned", taskId: planId, nodeId: planner.nodeId, attempt: 1 }),
      );
      m.after(900, () => {
        const reason = "trap: unreachable (assembly/index.ts:12:3)";
        m.emit({ t: "taskFailed", taskId: planId, reason });
        m.emit({ t: "executionFailed", executionId, reason: `task ${planId} failed: ${reason}` });
        m.execution = null;
        // Nothing runs and nobody has touched the dashboard for an hour: the machine sleeps until
        // the next execution wakes it (design §6.8).
        m.asleep = true;
        m.emit({ t: "machineSleeping", reason: DEMO_SLEEP_REASON });
        ended();
      });
    });
  };

  /** An execution ended one way or the other: hold if asked, else the next program after a beat. */
  const ended = (): void => {
    executionsEnded += 1;
    if (holdAfterFirst && executionsEnded === 1) {
      m.pause();
      return;
    }
    m.after(2_500, () => startNext());
  };

  const once = (at: number, fn: () => void): void => {
    if (m.done === at && !beats.has(at)) {
      beats.add(at);
      fn();
    }
  };

  /** The Mandelbrot story, keyed by tiles done in the frame. */
  const beat = (): void => {
    once(40, () => {
      // A straggler: n3 slows down, its task gets a speculative twin on a core, both agree.
      const n3 = m.nodes.get("n3");
      const core = m.nodes.get("core-1");
      const task = n3 && m.soloTaskOn("n3");
      if (!n3 || !core || !task) return;
      n3.health = "slow";
      m.emit({ t: "nodeHealth", nodeId: "n3", health: "slow" });
      m.assign(task, core, true);
    });
    once(90, () => {
      // A lying node: n6's late result disagrees with the twin's; the tile is withdrawn and recomputed.
      const n6 = m.nodes.get("n6");
      const core = m.nodes.get("core-2");
      const task = n6 && m.soloTaskOn("n6");
      if (!n6 || !core || !task) return;
      task.running.set("n6", (task.running.get("n6") as number) + 1000); // detach n6's timer
      m.assign(task, core, true);
      m.after(m.duration(core) + 350, () => {
        if (task.status !== "done" || !task.running.has("n6")) return;
        task.running.clear();
        m.tally.mismatched += 1;
        n6.tasksDone += 1;
        m.emit({ t: "taskMismatch", taskId: task.taskId, nodeId: "n6" });
        task.status = "pending";
        task.output = null;
        task.contested = true;
        m.done -= 1;
        const again = m.alive().find((x) => x.nodeId !== "n6" && !x.frozen);
        if (again) m.after(200, () => m.assign(task, again, false));
      });
    });
    once(200, () => {
      // Someone pressed kill half.
      const victims = ["n2", "core-2", "n6"].filter((id) => m.nodes.has(id));
      m.emit({ t: "controlApplied", op: "killHalf", nodeIds: victims });
      m.after(150, () => {
        for (const id of victims) {
          const n = m.nodes.get(id);
          if (n) m.leave(n, "closed");
        }
        m.fill();
      });
      m.after(2_200, () => {
        const n7 = m.node("n7", "e5f6", "tab", m.vnow);
        m.nodes.set(n7.nodeId, n7);
        m.emit({ t: "nodeJoined", node: m.view(n7) });
        m.fill();
      });
      m.after(3_400, () => {
        const c3 = m.node("core-3", "fleet", "core", m.vnow);
        m.nodes.set(c3.nodeId, c3);
        m.emit({ t: "nodeJoined", node: m.view(c3) });
        m.fill();
      });
    });
    once(320, () => {
      if (m.execution)
        m.emit({
          t: "budget",
          executionId: m.execution.executionId,
          computeMsUsed: 320 * 600,
          computeMsCap: 20 * 60_000,
        });
    });
    once(420, () => {
      const n1 = m.nodes.get("n1");
      if (!n1) return;
      n1.health = "throttled";
      n1.visible = false;
      m.emit({ t: "nodeHealth", nodeId: "n1", health: "throttled" });
      m.after(5_000, () => {
        if (m.nodes.get("n1") !== n1) return;
        n1.health = "fast";
        n1.visible = true;
        m.emit({ t: "nodeHealth", nodeId: "n1", health: "fast" });
      });
    });
    once(462, () => {
      // Another straggler late in the frame, so a twin is usually in flight around tile 470.
      const n1 = m.nodes.get("n1");
      const core = m.nodes.get("core-3") ?? m.nodes.get("core-1");
      const task = n1 && m.soloTaskOn("n1");
      if (!n1 || !core || !task) return;
      n1.health = "slow";
      m.emit({ t: "nodeHealth", nodeId: "n1", health: "slow" });
      m.assign(task, core, true);
    });
    once(465, () => {
      // A tab closes without a word: its open attempts are taken back at the deadline.
      const n3 = m.nodes.get("n3");
      if (n3) m.leave(n3, "silent");
      m.fill();
    });
    once(520, () => {
      // The hourly rotation: the next control plane's snapshot arrives under a new generation.
      m.emit({ t: "controlPlaneRotating", next: m.gen + 1, reconnectAfterMs: 2_400 });
      m.after(2_400, () => {
        m.gen += 1;
        m.snapshot();
      });
    });
  };

  return { beat, ended, startNext, nextStage };
}
