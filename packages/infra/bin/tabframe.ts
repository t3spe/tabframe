// CDK app entry: three stacks in dependency order, Core → Image → Fleet (design §11.4).
// Run via the repo-root cdk.json (`node packages/infra/bin/tabframe.ts`).
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import { CoreStack } from "../lib/core-stack.ts";
import { FleetStack } from "../lib/fleet-stack.ts";
import { ImageStack } from "../lib/image-stack.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

const app = new cdk.App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const env: cdk.Environment = {
  region: process.env.CDK_DEFAULT_REGION ?? "us-west-2",
  ...(account ? { account } : {}),
};

const budgetEmail = process.env.TABFRAME_BUDGET_EMAIL;
const core = new CoreStack(app, "TabframeCore", {
  env,
  ...(budgetEmail ? { budgetEmail } : {}),
});

const image = new ImageStack(app, "TabframeImage", {
  env,
  core,
  baseImageVersion: String(app.node.tryGetContext("baseImageVersion") ?? "1"),
  stagingDir: process.env.TABFRAME_IMAGE_DIR ?? resolve(repoRoot, "packages/infra/image"),
});

new FleetStack(app, "TabframeFleet", {
  env,
  core,
  image,
  fleetDir: resolve(repoRoot, "packages/fleet"),
});

app.synth();
