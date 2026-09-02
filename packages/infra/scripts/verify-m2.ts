// M2 verification runbook (plan WP2.7): the machine as a general-purpose computer, on AWS. A
// reviewer's path, driven by a browser: edit the Mandelbrot source in the page, compile it there,
// launch it, and watch the cluster run it; run word count over Moby-Dick and check the top-K
// against the goldens; make a program fault and watch the execution fail and the machine carry on.
//   node packages/infra/scripts/verify-m2.ts [--tabs 3] [--timeout 900]
import { readFileSync } from "node:fs";
import path from "node:path";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { type Browser, chromium, type Page } from "@playwright/test";
import { decodeBars, PROTOCOL_VERSION } from "@tabframe/protocol";
import { fetchSession, type Session, socketProtocols } from "../../node/src/session.ts";
import { maskAccount } from "./mask.ts";

const region = process.env.AWS_REGION ?? "us-west-2";
const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(name);
  const v = i > 0 ? Number(process.argv[i + 1]) : Number.NaN;
  return Number.isFinite(v) ? v : fallback;
};
const tabs = arg("--tabs", 3);
const timeoutS = arg("--timeout", 900);
const root = path.resolve(import.meta.dirname, "../../..");
const wordGoldens = JSON.parse(
  readFileSync(path.join(root, "programs/wordcount/goldens.json"), "utf8"),
) as {
  params: Record<string, unknown>;
  final: { hash: string; bars: Array<{ label: string; value: number }> };
};

const results: Array<{ check: string; result: string; pass: boolean | null }> = [];
function record(check: string, result: string, pass: boolean | null = null): void {
  results.push({ check, result, pass });
  console.log(`${pass === null ? "·" : pass ? "✓" : "✗"} ${check}: ${maskAccount(result)}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();

const cfn = new CloudFormationClient({ region });
async function outputs(stack: string): Promise<Record<string, string>> {
  const r = await cfn.send(new DescribeStacksCommand({ StackName: stack }));
  return Object.fromEntries(
    (r.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey ?? "", o.OutputValue ?? ""]),
  );
}
const fleet = await outputs("TabframeFleet");
const core = await outputs("TabframeCore");
const webOrigin = core.WebOrigin ?? "";
const sessionUrl = fleet.SessionUrl ?? "";
if (!webOrigin || !sessionUrl) throw new Error("stack outputs missing; deploy first");

async function session(): Promise<Session & { kind: "on" }> {
  for (let i = 0; i < 60; i++) {
    const s = await fetchSession(sessionUrl, (u) => fetch(u));
    if (s.kind === "on") return s;
    if (s.kind === "off") throw new Error("the machine is off; run `mise run up`");
    await sleep(s.retryAfterMs);
  }
  throw new Error("no control plane came up");
}
const on = await session();
record("session", `generation ${on.generation}`, true);

// ---- watch the machine ---------------------------------------------------------------------------
type Ev = { t: string; [k: string]: unknown };
const events: Ev[] = [];
const ws = new WebSocket(`${on.endpoint}/observer`, socketProtocols(on.token));
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => {
    ws.send(JSON.stringify({ t: "subscribe", v: PROTOCOL_VERSION, gen: on.generation }));
    resolve();
  };
  ws.onerror = () => reject(new Error("observer socket failed"));
});
ws.onmessage = (m) => events.push(JSON.parse(String(m.data)) as Ev);
const ping = setInterval(() => {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ t: "ping", v: PROTOCOL_VERSION, gen: on.generation }));
  }
}, 1_500);
const until = async (pred: () => boolean, ms: number, what: string): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) {
      record(what, "timed out", false);
      return false;
    }
    await sleep(500);
  }
  return true;
};
const started = () =>
  events.filter((e) => e.t === "executionStarted") as Array<
    Ev & { execution: { executionId: string; programName: string; human: boolean } }
  >;

// ---- the page: tabs lending CPU ---------------------------------------------------------------------
const browser: Browser = await chromium.launch();
// A killed run must not leave headless browsers lending nodes: they hold sockets the endpoint
// counts, and the next run cannot connect (found the hard way, WP2.7).
function closeAndExit(code: number, why: unknown): void {
  if (why) console.error(`  [verify-m2] ${String(why).slice(0, 300)}`);
  void browser.close().finally(() => process.exit(code));
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => closeAndExit(130, `${signal} received`));
}
process.on("uncaughtException", (err) => closeAndExit(1, err));
process.on("unhandledRejection", (err) => closeAndExit(1, err));
const pages: Page[] = [];
for (let i = 0; i < tabs; i++) {
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log(`  [tab] ${String(err).slice(0, 140)}`));
  // The machine rotates on its own every hour; a tab that opens mid-rotation waits for the new
  // control plane, so give it room and reload once rather than failing the run.
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(webOrigin, { waitUntil: "domcontentloaded" });
    try {
      await page.waitForFunction(
        () => (document.querySelector("#machine")?.textContent ?? "").includes("live"),
        undefined,
        { timeout: 120_000 },
      );
      break;
    } catch (err) {
      if (attempt === 1) throw err;
      console.log("  [verify-m2] the page was not live; reloading");
    }
  }
  await page.locator("#spawn1").click({ timeout: 30_000 });
  pages.push(page);
}
const editor = pages[0] as Page;
await until(() => events.filter((e) => e.t === "nodeJoined").length >= tabs, 60_000, "tabs joined");
record("tabs lending CPU", `${tabs} tabs, ${tabs * 2} nodes`, true);

// ---- 1. an edited program, compiled in the page, running on the cluster -------------------------------
await editor.click("#openEditor");
await editor.waitForFunction(
  () => (document.querySelector("#editorStatus")?.textContent ?? "").includes("ready in"),
  undefined,
  { timeout: 240_000 },
);
const readyIn = await editor.locator("#editorStatus").textContent();
// The edit: half the palette cycle, so the picture is visibly different and the tiles cannot be
// the goldens by accident.
const original = await editor.locator("#source").inputValue();
const source = original.replace(
  "const CYCLE: f64 = 48.0;",
  "const CYCLE: f64 = 24.0; // edited by verify-m2",
);
const edited = source !== original && source.includes("verify-m2");
if (!edited) {
  const near = /const CYCLE[^\n]*/.exec(original)?.[0] ?? original.slice(0, 160);
  console.log(`  [verify-m2] the source did not take the edit; nearest line: ${near}`);
}
await editor.locator("#source").fill(source);
await editor.locator("#programName").fill("mandelbrot-edited");
await editor.click("#compile");
await editor.waitForFunction(
  () => (document.querySelector("#editorStatus")?.textContent ?? "").includes("compiled in"),
  undefined,
  { timeout: 240_000 },
);
const compiledIn = await editor.locator("#editorStatus").textContent();
record(
  "compiled in the browser",
  `${(readyIn ?? "").trim()}; ${(compiledIn ?? "").trim()}${edited ? "; source edited" : "; SOURCE NOT EDITED"}`,
  edited,
);
await editor.locator("#programParams").fill('{"preset": 0, "palette": "fire"}');
// A person would not queue behind the machine's own loop: stop what is running first.
await editor.click("#closeEditor");
const running = editor.locator("#killExecution");
if (await running.isVisible()) {
  await running.click();
  await sleep(2_000);
}
await editor.click("#openEditor");
await editor.locator("#source").waitFor({ state: "visible", timeout: 60_000 });
await editor.click("#launch");
await editor.waitForFunction(
  () => /queued as|running as/.test(document.querySelector("#launchInfo")?.textContent ?? ""),
  undefined,
  { timeout: 60_000 },
);
const editedStarted = await until(
  () => started().some((e) => e.execution.programName === "mandelbrot-edited"),
  300_000,
  "the edited program started",
);
const editedId = started().find((e) => e.execution.programName === "mandelbrot-edited")?.execution
  .executionId;
const editedDone = await until(
  () => events.some((e) => e.t === "executionDone" && e.executionId === editedId),
  timeoutS * 1_000,
  "the edited program finished",
);
const editedTiles = new Set(
  events.filter((e) => e.t === "taskDone" && e.place !== null).map((e) => e.output as string),
);
const mandelbrotGoldens = new Set(
  (
    JSON.parse(readFileSync(path.join(root, "programs/mandelbrot/goldens.json"), "utf8")) as {
      hashes: string[];
    }
  ).hashes,
);
const differs = [...editedTiles].some((h) => !mandelbrotGoldens.has(h));
record(
  "an edited program runs on AWS from the page",
  editedStarted && editedDone
    ? `${editedId} finished; ${editedTiles.size} distinct tiles, ${differs ? "different from" : "IDENTICAL TO"} the unedited goldens`
    : "did not complete",
  editedStarted && editedDone && differs,
);

// ---- 2. word count over Moby-Dick ----------------------------------------------------------------
await editor.click("#closeEditor");
const wordcount = editor.locator('[data-launch="wordcount"]');
const haveWordcount = (await wordcount.count()) > 0;
if (haveWordcount) {
  // A person would not queue behind the machine's own loop: stop what is running first.
  const kill = editor.locator("#killExecution");
  if (await kill.isVisible()) {
    await kill.click();
    await sleep(2_000);
  }
  // The panel's program row opens a launch form; the form's own button sends it.
  await wordcount.first().click();
  await editor.locator('[data-launch-go="wordcount"]').click({ timeout: 30_000 });
  const wordStarted = await until(
    () => started().some((e) => e.execution.programName === "wordcount"),
    300_000,
    "word count started",
  );
  void wordStarted;
  const wordId = started().find((e) => e.execution.programName === "wordcount")?.execution
    .executionId;
  const wordDone = await until(
    () => events.some((e) => e.t === "executionDone" && e.executionId === wordId),
    timeoutS * 1_000,
    "word count finished",
  );
  // The answer is the last stage's only output, read from the execution's filesystem: fetch the
  // final root manifest by hash and take the highest /out/<stage>/0.
  const done = events.find((e) => e.t === "executionDone" && e.executionId === wordId) as
    | (Ev & { root: string | null })
    | undefined;
  let top = "";
  let matches = false;
  let finalHash = "";
  if (done?.root) {
    const base = on.storeBase.replace(/\/$/, "");
    const manifestRes = await fetch(`${base}/${done.root}`);
    if (manifestRes.ok) {
      const manifest = (await manifestRes.json()) as {
        files: Record<string, { hash: string; size: number }>;
      };
      const outputs = Object.keys(manifest.files)
        .filter((p) => /^\/out\/\d+\/0$/.test(p))
        .sort((a, b) => Number(a.split("/")[2]) - Number(b.split("/")[2]));
      const last = outputs.at(-1);
      finalHash = last ? (manifest.files[last]?.hash ?? "") : "";
      if (finalHash) {
        const res = await fetch(`${base}/${finalHash}`);
        if (res.ok) {
          const bars = decodeBars(new Uint8Array(await res.arrayBuffer()));
          top = bars
            .slice(0, 3)
            .map((b) => `${b.label} ${b.value}`)
            .join(", ");
          // The whole top-K, not just the head: this is the program's answer, and it is exact.
          const golden = wordGoldens.final.bars;
          matches =
            bars.length === golden.length &&
            golden.every((g, k) => bars[k]?.label === g.label && bars[k]?.value === g.value) &&
            finalHash === wordGoldens.final.hash;
        }
      }
    }
  }
  record(
    "word count over Moby-Dick",
    wordDone
      ? `${wordId} finished; top three: ${top || "unreadable"}; the top-${wordGoldens.final.bars.length} ${matches ? "equals the goldens" : "DIFFERS from the goldens"}`
      : "did not complete",
    wordDone && matches,
  );
} else {
  record("word count over Moby-Dick", "the program is not on this machine", false);
}

// ---- 3. a program fault fails visibly and the machine moves on --------------------------------------
await editor.click("#openEditor");
// The compiler is already loaded; its status now reads "compiled in …", so wait for the panel.
await editor.locator("#source").waitFor({ state: "visible", timeout: 60_000 });
await editor.locator("#source").fill(`import { emit, stage } from "@tabframe/sdk-as/assembly/index";
export { alloc } from "@tabframe/sdk-as/assembly/index";
export function plan(ptr: usize, len: i32): usize {
  abort("verify-m2: this planner refuses to plan");
  return emit(stage("never").toBytes());
}
export function run(ptr: usize, len: i32): usize {
  return emit(new Uint8Array(4));
}
`);
await editor.locator("#programName").fill("verify-m2-trap");
await editor.click("#compile");
await editor.waitForFunction(
  () => (document.querySelector("#editorStatus")?.textContent ?? "").includes("compiled in"),
  undefined,
  { timeout: 240_000 },
);
await editor.locator("#programParams").fill("{}");
await editor.click("#launch");
await editor.waitForFunction(
  () => /queued as|running as/.test(document.querySelector("#launchInfo")?.textContent ?? ""),
  undefined,
  { timeout: 60_000 },
);
const failed = await until(
  () =>
    events.some(
      (e) => e.t === "executionFailed" && String(e.reason ?? "").includes("refuses to plan"),
    ),
  240_000,
  "the faulty program failed",
);
await editor.click("#closeEditor");
const failure = events.find(
  (e) => e.t === "executionFailed" && String(e.reason ?? "").includes("refuses"),
);
const reason = String(failure?.reason ?? "");
record("a program fault fails its execution visibly", reason.slice(0, 120), failed);
// And the machine carries on: nodes intact, and something runs after the failure.
const movedOn = await until(
  () => started().length > (editedId ? 2 : 1),
  120_000,
  "the machine moved on",
);
record(
  "the machine moves on",
  `${events.filter((e) => e.t === "nodeLeft").length} nodes left in total; ${started().length} executions started`,
  movedOn,
);

clearInterval(ping);
ws.close();
await browser.close();
const passed = results.filter((r) => r.pass === true).length;
const failedChecks = results.filter((r) => r.pass === false).length;
console.log(
  `\n${passed} passed, ${failedChecks} failed, ${results.length - passed - failedChecks} informational; ${((Date.now() - t0) / 1000).toFixed(1)} s`,
);
process.exit(failedChecks ? 1 : 0);
