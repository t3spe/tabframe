// The IAM gate of `mise run deploy`: a deploy that would broaden IAM or security groups fails unless
// the broadening was reviewed and TABFRAME_DEPLOY_IAM=1 says so.
import { spawnSync } from "node:child_process";
import { assertTabframeIdentity } from "../../fleet/src/identity.ts";

assertTabframeIdentity(process.env);
if (process.env.TABFRAME_DEPLOY_IAM) {
  console.log("iam gate: acknowledged by TABFRAME_DEPLOY_IAM");
  process.exit(0);
}
const diff = spawnSync("cdk", ["diff", "--all", "--security-only", "--fail"], { stdio: "inherit" });
process.exit(diff.status ?? 1);
