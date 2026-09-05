// `mise run demo`: point the demo suite (e2e/demo.e2e.ts) at the deployed machine and run it;
// `--repeat N` runs it N times in a row, which is how "passes three times unattended" is read.
//   node packages/infra/scripts/demo.ts [--repeat 3] [--video]
import { spawnSync } from "node:child_process";
import { stackOutputs } from "../../fleet/src/operator.ts";

const i = process.argv.indexOf("--repeat");
const repeat = i > 0 ? Number(process.argv[i + 1]) || 1 : 1;
const video = process.argv.includes("--video");

const origin = (await stackOutputs("TabframeCore")).WebOrigin;
if (!origin) throw new Error("TabframeCore has no WebOrigin output; deploy first");

const r = spawnSync(
  "bunx",
  ["playwright", "test", "e2e/demo.e2e.ts", "--repeat-each", String(repeat), "--workers", "1"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      TABFRAME_URL: origin,
      ...(video ? { TABFRAME_VIDEO: "1" } : {}),
    },
  },
);
process.exit(r.status ?? 1);
