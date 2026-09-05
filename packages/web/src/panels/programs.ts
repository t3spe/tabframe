// The programs panel: one row per program the machine can launch, a launch form per open row.
import { type ClusterState, isRunningPhase, type ProgramInfo } from "../cluster-state.ts";
import { el } from "../dom.ts";
import { short } from "../format.ts";
import { parseParams } from "../params.ts";
import { programList } from "../selectors.ts";
import type { PanelContext } from "./context.ts";

type ProgramRow = {
  row: HTMLDivElement;
  name: HTMLElement;
  view: HTMLElement;
  running: HTMLElement;
  launch: HTMLButtonElement;
  desc: HTMLElement;
  bundleLine: HTMLElement;
  formSlot: HTMLDivElement;
};
type LaunchForm = { box: HTMLDivElement; input: HTMLTextAreaElement; error: HTMLElement };

/**
 * The rows and the open forms are kept and updated in place: a rebuild on every state event
 * replaced the textarea a person was typing in, and the caret went with it.
 */
export function mountPrograms(ctx: PanelContext): (state: ClusterState) => void {
  const { els, deps } = ctx;
  const programRows = new Map<string, ProgramRow>();
  const launchForms = new Map<string, LaunchForm>();

  function render(state: ClusterState): void {
    const programs = programList(state);
    const running =
      state.execution && isRunningPhase(state.execution.phase) ? state.execution.program : null;
    if (programs.length === 0) {
      if (programRows.size > 0 || els.programs.childElementCount === 0) {
        programRows.clear();
        launchForms.clear();
        els.programs.replaceChildren(
          el(
            "p",
            "muted",
            "No programs yet. The machine seeds its demos at boot; the editor uploads more.",
          ),
        );
      }
      return;
    }
    for (const [bundle, r] of programRows) {
      if (programs.some((p) => p.bundle === bundle)) continue;
      r.row.remove();
      programRows.delete(bundle);
      launchForms.delete(bundle);
    }
    for (const p of programs) {
      let r = programRows.get(p.bundle);
      if (!r) {
        r = buildProgramRow(p);
        programRows.set(p.bundle, r);
      }
      r.name.textContent = p.name;
      r.view.textContent = p.view ?? "view unknown";
      r.running.hidden = running !== p.bundle;
      r.launch.textContent = launchForms.has(p.bundle) ? "cancel" : "launch…";
      r.launch.dataset.launch = p.name;
      r.desc.textContent = p.description ?? "";
      r.desc.hidden = !p.description;
      r.bundleLine.textContent = `bundle ${short(p.bundle)}`;
    }
    // Rows are moved only when the order really changed (a program came or went): moving a node
    // that holds the focus would blur it.
    const wanted = programs.map((p) => (programRows.get(p.bundle) as ProgramRow).row);
    const current = [...els.programs.children];
    if (wanted.length !== current.length || wanted.some((node, i) => node !== current[i])) {
      const active = document.activeElement;
      els.programs.replaceChildren(...wanted);
      if (active instanceof HTMLElement && els.programs.contains(active)) active.focus();
    }
  }

  function buildProgramRow(p: ProgramInfo): ProgramRow {
    const row = el("div", "program");
    row.dataset.bundle = p.bundle;
    const head = el("div", "program-head");
    const name = el("b");
    const view = el("span", "pill");
    const running = el("span", "pill live", "running");
    running.hidden = true;
    const launch = el("button");
    launch.type = "button";
    launch.title = "Launch this program with params of your choosing; it goes ahead of the loop";
    head.append(name, view, running, launch);
    const desc = el("div", "muted small");
    const bundleLine = el("div", "mono muted small");
    const formSlot = el("div");
    row.append(head, desc, bundleLine, formSlot);
    launch.onclick = () => {
      const open = launchForms.get(p.bundle);
      if (open) {
        open.box.remove();
        launchForms.delete(p.bundle);
        launch.textContent = "launch…";
        return;
      }
      const form = buildLaunchForm(p, () => {
        launchForms.delete(p.bundle);
        launch.textContent = "launch…";
      });
      launchForms.set(p.bundle, form);
      formSlot.append(form.box);
      launch.textContent = "cancel";
      form.input.focus();
    };
    return { row, name, view, running, launch, desc, bundleLine, formSlot };
  }

  /** The form parses its params on blur and on launch, never on a keystroke; it says what is wrong. */
  function buildLaunchForm(p: ProgramInfo, done: () => void): LaunchForm {
    const box = el("div", "launch-form");
    const label = el("label", undefined, "params (JSON object)");
    const input = el("textarea");
    input.rows = 2;
    input.value = JSON.stringify(p.defaultParams);
    input.spellcheck = false;
    label.append(input);
    const error = el("div", "bad small");
    error.hidden = true;
    const parse = (): Record<string, unknown> | null => {
      const parsed = parseParams(input.value);
      if (!parsed.ok) {
        error.textContent = parsed.error;
        error.hidden = false;
        return null;
      }
      error.hidden = true;
      return parsed.value;
    };
    input.onblur = () => void parse();
    input.oninput = () => {
      error.hidden = true;
    };
    const go = el("button", undefined, `launch ${p.name}`);
    go.type = "button";
    go.dataset.launchGo = p.name;
    go.onclick = () => {
      const params = parse();
      if (!params) return;
      const sent = deps.send({ t: "launch", bundle: p.bundle, params, inherit: null });
      if (!sent) {
        error.textContent = "not connected; the launch was not sent";
        error.hidden = false;
        return;
      }
      box.remove();
      done();
    };
    box.append(label, go, error);
    return { box, input, error };
  }

  return render;
}
