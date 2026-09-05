// The web sandbox adapter in a real browser. The money shot proves the happy path — tabs compute
// tiles that hash to goldens — so what is left is the paths a healthy frame never takes: a program
// that spins forever must be killed at the deadline without wedging the cluster or the tab, and a
// program that traps must fail its execution visibly.
import { expect, type Page, test } from "@playwright/test";
import {
  ACCEPTED,
  installWatcher,
  killRunning,
  launchFromEditor,
  openEditorTab,
  watched,
} from "./helpers.ts";

const SPINNER = `import { emit, readRunInput, stage } from "@tabframe/sdk-as/assembly/index";
export { alloc } from "@tabframe/sdk-as/assembly/index";

export function plan(ptr: usize, len: i32): usize {
  const s = stage("spin");
  s.task(new Uint8Array(1));
  s.task(new Uint8Array(1));
  return emit(s.toBytes());
}

export function run(ptr: usize, len: i32): usize {
  const input = readRunInput(ptr, len);
  // Tile 0 never returns; tile 1 is instant. A node that takes the first must be killed at its
  // deadline, and the task must come back to the cluster.
  if (input.taskIndex == 0) {
    let x: f64 = 0;
    while (true) x += 1.0000001;
  }
  return emit(new Uint8Array(4));
}
`;

const TRAP = `import { emit, stage } from "@tabframe/sdk-as/assembly/index";
export { alloc } from "@tabframe/sdk-as/assembly/index";

export function plan(ptr: usize, len: i32): usize {
  abort("this planner refuses to plan");
  return emit(stage("never").toBytes());
}

export function run(ptr: usize, len: i32): usize {
  return emit(new Uint8Array(4));
}
`;

/** The machine's events as the in-page watcher saw them. */
const seenBy = (page: Page): Promise<string[]> => page.evaluate(watched).then((w) => w.seen);

/** The editor is its own page: open it beside the dashboard, compile, launch, close it. */
async function compileAndLaunch(page: Page, source: string, name: string): Promise<void> {
  const editor = await openEditorTab(page.context());
  await editor.locator("#source").fill(source);
  await editor.locator("#programName").fill(name);
  await editor.click("#compile");
  await expect(editor.locator("#editorStatus")).toHaveText(/compiled in \d+ ms/, {
    timeout: 180_000,
  });
  await launchFromEditor(editor, { params: "{}" }, ACCEPTED);
  await editor.close();
}

test("a program that never returns is killed at the deadline and its task is given away", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto("/");
  await expect(page.locator("#machine")).toHaveText(/live/, { timeout: 30_000 });
  await page.evaluate(installWatcher);
  // Three nodes: the spinner holds one, the others must carry the rest.
  await page.click("#spawn1");
  await page.click("#spawn1");
  await expect(page.locator("#counts")).toHaveText(/3 nodes/, { timeout: 30_000 });

  await compileAndLaunch(page, SPINNER, "spinner");

  // The control plane notices the overdue attempt and offers a twin (tier three); the tab that is
  // stuck is killed at its own deadline and carries on. Either way the cluster is not wedged.
  await expect
    .poll(() => seenBy(page), { timeout: 120_000, intervals: [1_000] })
    .toEqual(expect.arrayContaining([expect.stringMatching(/taskSpeculated|taskReassigned/)]));
  // The instant task finished, so the stage was not blocked by the spinning one.
  const seen = await seenBy(page);
  expect(seen).toEqual(expect.arrayContaining(["taskDone"]));
  // Every node is still there: a deadline kill terminates a sandbox worker, not a tab.
  await expect(page.locator("#counts")).toHaveText(/3 nodes/);
  await expect(page.locator("#mine .row").first()).toContainText(/idle|busy/, { timeout: 30_000 });
  // Leave the machine as we found it.
  await killRunning(page, 30_000);
});

test("a planner that traps fails its execution with the trap message", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/");
  await expect(page.locator("#machine")).toHaveText(/live/, { timeout: 30_000 });
  await page.evaluate(installWatcher);
  await expect(page.locator("#counts")).toHaveText(/[1-9] nodes/, { timeout: 30_000 });

  await compileAndLaunch(page, TRAP, "trapper");

  // The trap comes back as a task failure carrying the program's own message, and the execution
  // fails with it rather than hanging.
  try {
    await expect
      .poll(() => seenBy(page), { timeout: 120_000, intervals: [1_000] })
      .toEqual(
        expect.arrayContaining([expect.stringMatching(/executionFailed:.*refuses to plan/)]),
      );
  } catch (err) {
    // The whole event list, untruncated, beside the failure: the reporter cuts arrays.
    await test.info().attach("seen", {
      body: JSON.stringify(await seenBy(page), null, 1),
      contentType: "application/json",
    });
    await test.info().attach("mine", {
      body: await page.locator("#mine").innerText(),
      contentType: "text/plain",
    });
    throw err;
  }
  await expect(page.locator("#failure")).toContainText(/refuses to plan/, { timeout: 30_000 });
  // The machine moves on rather than hanging: the nodes are still there.
  await expect(page.locator("#counts")).toHaveText(/[1-9] nodes/);
});
