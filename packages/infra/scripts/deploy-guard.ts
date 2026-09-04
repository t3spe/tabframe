// The deploy guard (WP8.1, tightened in WP8.2): a deploy builds the image from the working tree, so
// the tree must be committed, HEAD must be origin/main itself (not merely an ancestor: a stale
// checkout deploys an old image with a clean-looking stamp), and CI must be green for that commit
// when `gh` can tell. TABFRAME_DEPLOY_UNGATED=1 skips it for an emergency deploy from a branch.
import { execSync } from "node:child_process";

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
  console.warn(
    "[deploy-guard] could not fetch origin/main; checking against what is known locally",
  );
}
const head = sh("git rev-parse HEAD");
let main = "";
try {
  main = sh("git rev-parse origin/main");
} catch {
  main = sh("git rev-parse main");
}
if (head !== main) {
  console.error(
    `[deploy-guard] HEAD ${head.slice(0, 7)} is not origin/main (${main.slice(0, 7)}); pull, or merge first with CI green, then deploy`,
  );
  process.exit(1);
}
try {
  const runs = sh(
    `gh run list --commit ${head} --workflow CI --status success --limit 1 --json conclusion`,
  );
  if (!runs.includes("success")) {
    console.error(`[deploy-guard] no successful CI run for ${head.slice(0, 7)} yet; wait for CI`);
    process.exit(1);
  }
  console.log(`[deploy-guard] ok: clean tree at ${head.slice(0, 7)} = origin/main, CI green`);
} catch {
  console.warn(
    `[deploy-guard] ok: clean tree at ${head.slice(0, 7)} = origin/main (gh unavailable: CI not checked)`,
  );
}
