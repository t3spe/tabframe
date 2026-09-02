// The web sandbox adapter in a real browser (plan WP2.6). The money shot proves the happy path —
// tabs compute tiles that hash to goldens — so what is left is the paths a healthy frame never
// takes: a program that spins forever must be killed at the deadline without wedging the cluster
// or the tab, and a program that traps must fail its execution visibly.
import { expect, type Page, test } from "@playwright/test";

/** Collect the machine's own events from a second observer socket inside the page. */
function watch(): void {
  const w = window as unknown as { __seen: string[] };
  if (w.__seen) return;
  w.__seen = [];
  void (async () => {
    const config = (await (await fetch("/config.json")).json()) as { sessionUrl: string };
    const session = (await (await fetch(config.sessionUrl)).json()) as {
      endpoint?: string;
      generation?: number;
    };
    if (!session.endpoint) return;
    const gen = session.generation ?? 1;
    const ws = new WebSocket(`${session.endpoint}/observer`);
    ws.onopen = () => ws.send(JSON.stringify({ t: "subscribe", v: 1, gen }));
    ws.onmessage = (m) => {
      const e = JSON.parse(String(m.data)) as { t: string; reason?: string };
      w.__seen.push(e.reason ? `${e.t}:${e.reason.slice(0, 80)}` : e.t);
    };
    setInterval(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: "ping", v: 1, gen }));
    }, 1_500);
  })();
}

const seenBy = () => (window as unknown as { __seen?: string[] }).__seen ?? [];

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

async function compileAndLaunch(page: Page, source: string, name: string): Promise<void> {
  await page.click("#openEditor");
  await expect(page.locator("#editor")).toBeVisible();
  await expect(page.locator("#editorStatus")).toHaveText(/ready in/, { timeout: 180_000 });
  await page.locator("#source").fill(source);
  await page.locator("#programName").fill(name);
  await page.click("#compile");
  await expect(page.locator("#editorStatus")).toHaveText(/compiled in \d+ ms/, {
    timeout: 180_000,
  });
  await page.locator("#programParams").fill("{}");
  await page.click("#launch");
  await expect(page.locator("#launchInfo")).toContainText(/queued as|running as/, {
    timeout: 60_000,
  });
  await page.click("#closeEditor");
}

test("a program that never returns is killed at the deadline and its task is given away", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto("/");
  await expect(page.locator("#machine")).toHaveText(/live/, { timeout: 30_000 });
  await page.evaluate(watch);
  // Three nodes: the spinner holds one, the others must carry the rest.
  await page.click("#spawn1");
  await page.click("#spawn1");
  await expect(page.locator("#counts")).toHaveText(/3 nodes/, { timeout: 30_000 });

  await compileAndLaunch(page, SPINNER, "spinner");

  // The control plane notices the overdue attempt and offers a twin (tier three); the tab that is
  // stuck is killed at its own deadline and carries on. Either way the cluster is not wedged.
  await expect
    .poll(async () => page.evaluate(seenBy), { timeout: 120_000, intervals: [1_000] })
    .toEqual(expect.arrayContaining([expect.stringMatching(/taskSpeculated|taskReassigned/)]));
  // The instant task finished, so the stage was not blocked by the spinning one.
  const seen = await page.evaluate(seenBy);
  expect(seen).toEqual(expect.arrayContaining(["taskDone"]));
  // Every node is still there: a deadline kill terminates a sandbox worker, not a tab.
  await expect(page.locator("#counts")).toHaveText(/3 nodes/);
  await expect(page.locator("#mine .row").first()).toContainText(/idle|busy/, { timeout: 30_000 });
  // Leave the machine as we found it.
  await page.click("#killExecution");
  await expect(page.locator("#failure")).toContainText("cancelled by an operator", {
    timeout: 30_000,
  });
});

test("a planner that traps fails its execution with the trap message", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/");
  await expect(page.locator("#machine")).toHaveText(/live/, { timeout: 30_000 });
  await page.evaluate(watch);
  await expect(page.locator("#counts")).toHaveText(/[1-9] nodes/, { timeout: 30_000 });

  await compileAndLaunch(page, TRAP, "trapper");

  // The trap comes back as a task failure carrying the program's own message, and the execution
  // fails with it rather than hanging.
  await expect
    .poll(async () => page.evaluate(seenBy), { timeout: 120_000, intervals: [1_000] })
    .toEqual(expect.arrayContaining([expect.stringMatching(/executionFailed:.*refuses to plan/)]));
  await expect(page.locator("#failure")).toContainText(/refuses to plan/, { timeout: 30_000 });
  // The machine moves on rather than hanging: the nodes are still there.
  await expect(page.locator("#counts")).toHaveText(/[1-9] nodes/);
});
