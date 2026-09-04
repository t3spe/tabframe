// The deploy guard (WP8.1): a deploy builds the image from the working tree, so the tree must be
// committed and its HEAD must be on origin/main — the commit CI made green. Set
// TABFRAME_DEPLOY_UNGATED=1 to skip it for an emergency deploy from a branch.
import { execSync } from "node:child_process";

const sh = (cmd: string): string => execSync(cmd, { encoding: "utf8" }).trim();

if (process.env.TABFRAME_DEPLOY_UNGATED === "1") {
  console.log("[deploy-guard] skipped (TABFRAME_DEPLOY_UNGATED=1)");
  process.exit(0);
}
const dirty = sh("git status --porcelain");
if (dirty) {
  console.error("[deploy-guard] the working tree has uncommitted changes:\n" + dirty);
  process.exit(1);
}
try {
  sh("git fetch -q origin main");
} catch {
  console.warn("[deploy-guard] could not fetch origin/main; checking against the local main");
}
const head = sh("git rev-parse HEAD");
let onMain = false;
try {
  sh("git merge-base --is-ancestor HEAD origin/main");
  onMain = true;
} catch {
  try {
    sh("git merge-base --is-ancestor HEAD main");
    onMain = true;
  } catch {
    onMain = false;
  }
}
if (!onMain) {
  console.error(
    `[deploy-guard] HEAD ${head.slice(0, 7)} is not on main; merge first (CI green), then deploy`,
  );
  process.exit(1);
}
console.log(`[deploy-guard] ok: clean tree at ${head.slice(0, 7)}, on main`);
