import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

// WP2.5: dashboard v2. The demo machine now cycles through three programs, so the panels can be
// checked without a cluster: a word count (three stages, a bars result, a filesystem to browse,
// logs on the tasks) and a broken program (the failure banner). Against the real local control
// plane: an uploaded program appears in the programs panel, launches from it, and the running
// execution can be killed from the page.

const wasmPath = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../programs/mandelbrot/dist/program.wasm",
);

const waitHeld = async (page: Page) => {
  await page.waitForSelector("body[data-demo-paused]", { timeout: 90_000 });
};

test("demo: word count runs three stages, draws its bars, and its files can be browsed", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.goto("/?demo=1&speed=12&program=wordcount&hold=1");
  await expect(page.locator("#machine")).toHaveText("live · demo");
  // The programs panel lists what the machine can run, with a launch form per program.
  await expect(page.locator("#programs .program")).toHaveCount(3);
  await expect(page.locator("#programs")).toContainText("mandelbrot");
  await expect(page.locator("#programs")).toContainText("wordcount");
  await expect(page.locator("#programs")).toContainText("broken");
  await expect(page.locator('[data-launch="wordcount"]')).toBeVisible();
  // The queue has a person's execution waiting, with a drop button.
  await expect(page.locator("#queue")).toContainText("wordcount e39");
  await expect(page.locator('#queue [data-drop="e39"]')).toBeVisible();

  await waitHeld(page);
  await expect(page.locator("#exec")).toHaveText("wordcount · done · 1/1");
  // Three stages in the strip, all done, with their tallies.
  const stages = page.locator("#strip .stage");
  await expect(stages).toHaveCount(3);
  await expect(stages.nth(0)).toContainText("0 map");
  await expect(stages.nth(0)).toContainText("8/8");
  await expect(stages.nth(1)).toContainText("1 reduce");
  await expect(stages.nth(2)).toContainText("2 merge");
  await expect(stages.nth(2)).toContainText("1/1");
  await expect(page.locator("#strip .stage-plan")).toHaveCount(0);
  // The warning the control plane raised is on the execution, not just in the activity list.
  await expect(page.locator("#warnings")).toBeVisible();
  await expect(page.locator("#warnings")).toContainText("inherited from e38 is gone");
  // The bars view: the merge task's output, fetched by hash and decoded, longest first.
  await expect(page.locator("#result .bars .bar-row")).toHaveCount(25, { timeout: 15_000 });
  await expect(page.locator("#result .bar-row").first()).toHaveAttribute("data-label", "the");
  await expect(page.locator("#result .bar-row").first()).toContainText("14,529");
  await expect(page.locator("#result")).toContainText("/out/2/0");
  // The dashboard keeps a one-line summary of the filesystem and a link to its own tab (WP6.3).
  await expect(page.locator("#filesRoot")).not.toHaveText("—");
  await expect(page.locator("#filesSummary")).toContainText(/root \S+ · \d+ files/);
  await expect(page.locator("#filesPanel .open-panel")).toHaveAttribute("href", /panel=files/);
  await expect(page.locator("#files")).toBeHidden();
  // The files tab follows the execution's root: bundle files, the corpus, every stage's outputs.
  const files = await page.context().newPage();
  await files.goto("/?demo=1&speed=12&program=wordcount&hold=1&panel=files");
  await waitHeld(files);
  await expect(files.locator("#filesPanel .panel-explain")).toBeVisible();
  await expect(files.locator(".hero")).toBeHidden();
  await expect(files.locator("#files")).toContainText("/program.wasm");
  await expect(files.locator("#files")).toContainText("/in/corpus.txt");
  await expect(files.locator("#files")).toContainText("/out/0/7");
  await expect(files.locator("#files")).toContainText("/out/2/0");
  await expect(files.locator("#files .file-group")).toHaveCount(5);
  // A click previews the file: a map partition is text.
  await files.click('#files li[data-path="/out/0/3"]');
  await expect(files.locator("#filePreview")).toBeVisible();
  await expect(files.locator("#filePreview .text-view")).toContainText(/^[a-z]+ \d+/);
  // The corpus is text too; the bars payload draws as bars.
  await files.click('#files li[data-path="/out/2/0"]');
  await expect(files.locator("#filePreview .bars .bar-row")).toHaveCount(25);
  // Browsing an earlier root shows the filesystem as it was after stage 0.
  await files.click('#files button[data-root-stage="0"]');
  await expect(files.locator("#files")).toContainText("browsing a chosen root");
  await expect(files.locator("#files")).toContainText("/out/0/7");
  await expect(files.locator("#files")).not.toContainText("/out/2/0");
  await files.click("#files button:has-text('follow the execution')");
  await expect(files.locator("#files")).toContainText("/out/2/0");
  await files.close();
  // Task detail: the last stage's one task, its attempt, and its log fetched from the store.
  const grid = page.locator("#grid");
  await expect(grid).toBeVisible();
  await grid.click({ position: { x: 4, y: 4 } });
  await expect(page.locator("#taskDetail")).toBeVisible();
  await expect(page.locator("#taskDetail")).toContainText("done");
  await expect(page.locator("#taskDetail")).toContainText("stage 2 · index 0");
  await expect(page.locator("#taskDetail table.attempts tbody tr")).toHaveCount(1);
  await expect(page.locator("#taskDetail table.attempts tbody tr").first()).toContainText(
    "primary",
  );
  await expect(page.locator("#taskDetail .task-log .text-view")).toContainText(
    "merge: read 8 partitions",
    { timeout: 15_000 },
  );
  // A second click on the same cell clears the selection.
  await grid.click({ position: { x: 4, y: 4 } });
  await expect(page.locator("#taskDetail")).toBeHidden();
});

test("demo: a program that traps fails visibly, and the banner can be dismissed", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/?demo=1&speed=12&program=broken&hold=1");
  await waitHeld(page);
  await expect(page.locator("#exec")).toHaveText("broken · failed · 0/0");
  await expect(page.locator("#exec")).toHaveClass(/off/);
  await expect(page.locator("#failure")).toBeVisible();
  await expect(page.locator("#failure")).toContainText("broken");
  await expect(page.locator("#failure")).toContainText("trap: unreachable");
  await expect(page.locator("#result")).toContainText("no result");
  await expect(page.locator("#activity")).toContainText("failed: task");
  await page.click("#failure button");
  await expect(page.locator("#failure")).toBeHidden();
});

test("live: an upload shows up in the programs panel, launches from it, and can be killed", async ({
  page,
}) => {
  test.setTimeout(240_000);
  // The local control plane is shared with the other suites: an earlier test may have uploaded
  // this same program and left an execution planning (no nodes in observe mode). Everything below
  // is relative to what is there when the page opens.
  await page.goto("/?observe");
  await expect(page.locator("#machine")).toHaveText(/live/, { timeout: 30_000 });
  const programsBefore = await page.locator("#programs .program").count();

  // Upload through the editor's drop door; the control plane validates the bundle and the
  // program shows up in the panel, with its view, whether it was known before or not.
  const editor = await page.context().newPage();
  await editor.goto("/editor.html");
  // The drop-door handler attaches only once the compiler reports ready; on a slow CI runner
  // that can take longer than the file drop below would wait.
  await expect(editor.locator("#editorStatus")).toHaveText(/ready in/, { timeout: 180_000 });
  await editor.locator("#wasmFile").setInputFiles(wasmPath);
  await expect(editor.locator("#launch")).toBeEnabled({ timeout: 15_000 });
  // A dropped module is named after its file; give it the program's real name.
  await editor.locator("#programName").fill("mandelbrot");
  await editor.locator("#programParams").fill('{"preset": 2, "palette": "ocean"}');
  await editor.click("#launch");
  await expect(editor.locator("#launchInfo")).toContainText("launch sent", { timeout: 30_000 });
  // Controls leave the tab spaced under the observer rate: wait for the control plane's answer
  // before closing it, or the launch may still be in the outbox.
  await expect(editor.locator("#launchInfo")).toContainText(/answered|queued as|running as/, {
    timeout: 30_000,
  });
  await editor.close();
  await expect(page.locator('[data-launch="mandelbrot"]')).toBeVisible({ timeout: 30_000 });
  expect(await page.locator("#programs .program").count()).toBeGreaterThanOrEqual(
    Math.max(1, programsBefore),
  );
  await expect(page.locator("#programs")).toContainText("mandelbrot");
  // An execution of it is running (planning with no nodes, or rendering with nodes another suite
  // left behind); the panel marks the program as running and the strip shows where it is.
  await expect(page.locator("#exec")).toContainText(/mandelbrot · (planning|render)/, {
    timeout: 15_000,
  });
  await expect(page.locator("#strip .stage")).not.toHaveCount(0);
  // The row is the one with the mandelbrot launch button; another suite's upload of the same
  // module under another name mentions Mandelbrot in its description.
  const mandelbrotRow = page.locator("#programs .program", {
    has: page.locator('[data-launch="mandelbrot"]'),
  });
  await expect(mandelbrotRow).toContainText("running");
  // Kill the running execution from the page: the failure banner names the reason.
  await expect(page.locator("#killExecution")).toBeVisible();
  await page.click("#killExecution");
  await expect(page.locator("#failure")).toContainText("cancelled by an operator", {
    timeout: 15_000,
  });

  // Launch from the programs panel with edited params: queued by a person, then running or
  // waiting behind whatever was already queued.
  await page.click('[data-launch="mandelbrot"]');
  await page.locator("#programs .launch-form textarea").fill('{"preset": 1, "palette": "ocean"}');
  await page.click('[data-launch-go="mandelbrot"]');
  await expect(page.locator("#activity")).toContainText("queued by a person", { timeout: 15_000 });
  await expect(page.locator("#exec")).toContainText(/mandelbrot · (planning|render)/, {
    timeout: 15_000,
  });
  await expect(page.locator("#failure")).toBeVisible(); // the earlier failure stays until a success
  // Another launch queues behind; the queue shows it with a drop button that removes it.
  const drops = page.locator("#queue [data-drop]");
  const queued = await drops.count();
  await page.click('[data-launch="mandelbrot"]');
  await page.click('[data-launch-go="mandelbrot"]');
  await expect(drops).toHaveCount(queued + 1, { timeout: 15_000 });
  await expect(page.locator("#queue")).toContainText("mandelbrot");
  await drops.last().click();
  await expect(drops).toHaveCount(queued, { timeout: 15_000 });
  // Bad params never leave the page.
  await page.click('[data-launch="mandelbrot"]');
  await page.locator("#programs .launch-form textarea").fill("[1, 2]");
  await page.click('[data-launch-go="mandelbrot"]');
  await expect(page.locator("#programs .launch-form")).toContainText(
    "params must be a JSON object",
  );
});

test("demo: the ledger and the activity log open full-width in their own tabs, the dashboard keeps a summary", async ({
  page,
  context,
}) => {
  test.setTimeout(150_000);
  await page.goto("/?demo=1&speed=12&pause=300");
  await page.waitForSelector("body[data-demo-paused]", { timeout: 90_000 });
  await expect(page.locator("#ledgerSummary")).toContainText(
    /\d+ settled tasks · .* · hashes, not bytes/,
  );
  await expect(page.locator("#ledger")).toBeHidden();
  await expect(page.locator("#activitySummary")).toContainText(/\d+ lines · last:/);
  await expect(page.locator("#activity")).toBeHidden();
  const href = await page.locator("#ledgerPanel .open-panel").getAttribute("href");
  expect(href).toContain("panel=ledger");
  // The ledger tab: the explanation, every settled task, nothing else on the page.
  const ledger = await context.newPage();
  await ledger.goto("/?demo=1&speed=12&pause=300&panel=ledger");
  await ledger.waitForSelector("body[data-demo-paused]", { timeout: 90_000 });
  await expect(ledger.locator("#ledgerPanel .panel-explain")).toContainText("hashes");
  await expect(ledger.locator(".hero")).toBeHidden();
  await expect(ledger.locator("#programs")).toBeHidden();
  await expect(ledger.locator("#ledger tbody tr[data-hash]")).toHaveCount(300);
  await expect(ledger).toHaveTitle(/ledger/);
  await ledger.close();
  // The activity tab keeps the whole log, not the dashboard's last fourteen lines.
  const activity = await context.newPage();
  await activity.goto("/?demo=1&speed=12&pause=300&panel=activity");
  await activity.waitForSelector("body[data-demo-paused]", { timeout: 90_000 });
  await expect(activity.locator("#activityPanel .panel-explain")).toBeVisible();
  const held = await activity.evaluate(
    () =>
      (window as unknown as { tabframe: { state: { activity: unknown[] } } }).tabframe.state
        .activity.length,
  );
  expect(held).toBeGreaterThan(0);
  expect(await activity.locator("#activity li").count()).toBe(held);
  await activity.close();
});
