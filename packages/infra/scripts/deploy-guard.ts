// The deploy guard: a deploy builds the image from the working tree, so the tree must be committed,
// HEAD must be origin/main itself (not merely an ancestor: a stale checkout deploys an old image
// with a clean-looking stamp), and CI must be green for that commit. It fails closed — a guard that
// shrugs at a failed fetch or a broken `gh` is no guard on the flaky-network night it matters —
// and TABFRAME_DEPLOY_UNGATED=1 is the one way past it, for an emergency deploy from a branch.
import { execSync } from "node:child_process";
import { budgetDecision } from "../lib/app-config.ts";

const sh = (cmd: string): string =>
  execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

if (process.env.TABFRAME_DEPLOY_UNGATED === "1") {
  console.log("[deploy-guard] skipped (TABFRAME_DEPLOY_UNGATED=1)");
  process.exit(0);
}
const dirty = sh("git status --porcelain");
if (dirty) {
  console.error(`[deploy-guard] the working tree has uncommitted changes:\n${dirty}`);
  process.exit(1);
}
try {
  sh("git fetch -q origin main");
} catch {
  console.error("[deploy-guard] could not fetch origin/main; fix the network or the remote first");
  process.exit(1);
}
const head = sh("git rev-parse HEAD");
const main = sh("git rev-parse origin/main");
if (head !== main) {
  console.error(
    `[deploy-guard] HEAD ${head.slice(0, 7)} is not origin/main (${main.slice(0, 7)}); pull, or merge first with CI green, then deploy`,
  );
  process.exit(1);
}
try {
  sh("gh auth status");
} catch {
  console.error(
    "[deploy-guard] `gh auth status` failed: log in with `gh auth login` so CI can be checked",
  );
  process.exit(1);
}
let runs = "";
try {
  runs = sh(
    `gh run list --commit ${head} --workflow CI --status success --limit 1 --json conclusion`,
  );
} catch (err) {
  console.error(`[deploy-guard] could not list CI runs: ${String(err)}`);
  process.exit(1);
}
if (!runs.includes("success")) {
  console.error(`[deploy-guard] no successful CI run for ${head.slice(0, 7)} yet; wait for CI`);
  process.exit(1);
}
// The budget and the alarm mail exist only when the address is configured: a deploy from a
// checkout without it would silently delete both.
if (budgetDecision(process.env, "deploy").kind === "missing") {
  console.error(
    "[deploy-guard] TABFRAME_BUDGET_EMAIL is not set (.env.local): the deploy would remove the budget and the alarm subscription. Set it, or TABFRAME_NO_BUDGET=1 to mean it.",
  );
  process.exit(1);
}
console.log(`[deploy-guard] ok: clean tree at ${head.slice(0, 7)} = origin/main, CI green`);
