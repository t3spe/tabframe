import { describe, expect, test } from "bun:test";
import {
  connectionCopy,
  kindLabel,
  LEGEND,
  LOOP_TITLES,
  loopLabel,
  machineCopy,
  machineSentence,
  PULSE_TEXT,
  ROTATING_DETAIL,
  stopTitle,
  TASK_COLOR_LABELS,
} from "./copy.ts";
import { at, execution } from "./fixtures.ts";

describe("banner copy", () => {
  test("every connection state says what is happening and what the visitor can do", () => {
    for (const state of ["connecting", "starting", "off", "outdated"] as const) {
      const c = connectionCopy(state);
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.body.length).toBeGreaterThan(20);
      expect(c.hint.length).toBeGreaterThan(0);
    }
    expect(connectionCopy("off").body).toContain("mise run up");
    expect(connectionCopy("off").hint).toContain("?demo=1");
    expect(connectionCopy("starting").title).toContain("Waking");
    expect(connectionCopy("full").hint).toContain("ten seconds");
    expect(connectionCopy("connecting", ROTATING_DETAIL).title).toContain("rotating");
    expect(connectionCopy("connecting", ROTATING_DETAIL).body).toContain("new generation");
    expect(connectionCopy("connecting", "retrying").body).toBe("retrying");
    expect(connectionCopy("outdated", "protocol 3").body).toContain("protocol 3");
    expect(connectionCopy("outdated").hint).toContain("Reloading");
  });

  test("the machine banners name the generation and the reason", () => {
    const r = machineCopy({ kind: "rotating", next: 8, msLeft: 2_400 });
    expect(r.title).toBe("Control plane rotating to generation 8.");
    expect(r.body).toContain("fresh MicroVM");
    const s = machineCopy({ kind: "sleeping", reason: "ten minutes with nobody watching" });
    expect(s.title).toContain("going to sleep");
    expect(s.body).toContain("ten minutes with nobody watching");
    expect(s.hint).toContain("wakes it");
    const a = machineCopy({ kind: "asleep", reason: null });
    expect(a.title).toContain("asleep");
    expect(a.body).toContain("Your visit wakes it");
    expect(machineCopy({ kind: "asleep", reason: "x" }).body).toContain("after x");
  });
});

describe("the legend and the pulses", () => {
  test("the legend names every colour once, in the order a task passes through them", () => {
    const keys = TASK_COLOR_LABELS.map(([k]) => k);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([
      "pending",
      "assigned",
      "speculated",
      "released",
      "done",
      "verified",
      "mismatch",
      "failed",
    ]);
    expect(TASK_COLOR_LABELS.every(([, label]) => label.length > 0)).toBe(true);
    expect(LEGEND.map(([k]) => k)).toEqual([...keys, "flash", "contested"]);
  });

  test("every flash kind has a line that names the task and the node", () => {
    const pulse = { at: 1, seq: 2, taskId: "t7", nodeId: "n3" } as const;
    for (const kind of ["released", "speculated", "verified", "mismatch"] as const) {
      const text = PULSE_TEXT[kind]({ ...pulse, kind });
      expect(text).toContain("t7");
      expect(text).toContain("n3");
    }
    expect(PULSE_TEXT.released({ ...pulse, kind: "released" })).toBe("t7 taken back from n3");
  });

  test("a node's kind reads as where it runs", () => {
    expect(kindLabel("tab")).toBe("tab");
    expect(kindLabel("core")).toBe("cloud core");
  });
});

describe("the loop pill and Stop's tooltip", () => {
  test("the loop pill's words and tooltip follow its state", () => {
    expect(loopLabel(at({ yielded: true }))).toBe("loop · yielded to you");
    expect(loopLabel(at({ paused: true }))).toBe("loop · paused by the editor");
    expect(loopLabel(at({ stopped: true }))).toBe("loop · held by Stop");
    expect(loopLabel(at({}))).toBe("loop · running");
    for (const state of ["running", "held", "yielded", "paused"] as const)
      expect(LOOP_TITLES[state].length).toBeGreaterThan(20);
  });

  test("Stop's tooltip names what it would end", () => {
    const yours = execution("running", {
      executionId: "e7",
      programName: "wordcount",
      human: true,
    });
    expect(stopTitle(at({}, yours))).toContain("Ends wordcount e7 (a person's launch)");
    expect(stopTitle(at({ yielded: true }, execution("done")))).toContain("before its next frame");
  });
});

describe("the sentence of state (rule R1)", () => {
  const exec = (phase: Parameters<typeof execution>[0], human: boolean, view = "tiles" as const) =>
    execution(phase, {
      executionId: "e3",
      programName: "mandelbrot",
      human,
      view,
      stageName: "render",
    });
  const live = { live: true, demo: false, observe: false };

  test("nothing while disconnected; the loop's frame, a person's launch, held, yielded, paused, failed, idle", () => {
    expect(machineSentence(at({}), { ...live, live: false })).toBeNull();
    expect(machineSentence(at({}, exec("running", false), 9), live)).toBe(
      "rendering mandelbrot e3 · render · 9 nodes",
    );
    expect(machineSentence(at({}, exec("planning", true), 1), live)).toBe(
      "running your mandelbrot e3 · planning · 1 node · the loop waits behind it",
    );
    expect(machineSentence(at({ stopped: true }), live)).toBe(
      "stopped by you · nothing runs until Start · a launch of yours still runs at once",
    );
    expect(machineSentence(at({ yielded: true }, exec("done", true)), live)).toBe(
      "your mandelbrot e3 is done · the result stays · the loop waits for Start or ten quiet minutes",
    );
    expect(machineSentence(at({ paused: true }, exec("running", false), 2), live)).toMatch(
      /^paused · the editor tab is open/,
    );
    expect(machineSentence(at({}, exec("failed", false)), live)).toBe(
      "mandelbrot e3 failed · the loop tries again in a moment",
    );
    expect(machineSentence(at({}, exec("failed", true)), live)).toBe(
      "your mandelbrot e3 failed · the loop is free again",
    );
    expect(machineSentence(at({}, exec("stopped", false)), live)).toBe(
      "mandelbrot e3 was stopped · the loop is free again",
    );
    expect(machineSentence(at({}), live)).toBe(
      "idle · the loop starts a frame when someone watches",
    );
  });

  test("the demo and an observer say what they are first", () => {
    expect(machineSentence(at({}), { ...live, demo: true })).toMatch(
      /^demo · a scripted cluster inside this page, nothing is sent anywhere · idle/,
    );
    expect(machineSentence(at({}), { ...live, observe: true })).toMatch(
      /^observing · this tab lends no cores · idle/,
    );
  });
});
