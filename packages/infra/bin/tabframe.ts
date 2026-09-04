import { existsSync } from "node:fs";
// CDK app entry: four stacks in dependency order, Core → Image → Fleet → Web (design §11.4).
// Run via the repo-root cdk.json (`node packages/infra/bin/tabframe.ts`).
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import { CoreStack } from "../lib/core-stack.ts";
import { FleetStack } from "../lib/fleet-stack.ts";
import { ImageStack } from "../lib/image-stack.ts";
import { WebStack } from "../lib/web-stack.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

const app = new cdk.App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const env: cdk.Environment = {
  region: process.env.CDK_DEFAULT_REGION ?? "us-west-2",
  ...(account ? { account } : {}),
};

const budgetEmail = process.env.TABFRAME_BUDGET_EMAIL;

function stagingDirOrRefuse(): string {
  const dir = process.env.TABFRAME_IMAGE_DIR ?? resolve(repoRoot, "packages/infra/image-dist");
  if (existsSync(resolve(dir, "main.js")) && existsSync(resolve(dir, "build.json"))) return dir;
  if (process.env.TABFRAME_IMAGE_PLACEHOLDER === "1")
    return resolve(repoRoot, "packages/infra/image");
  throw new Error(
    `${dir} holds no staged image (main.js and build.json): run \`mise run build\` first, or set TABFRAME_IMAGE_PLACEHOLDER=1 to deploy the placeholder on purpose`,
  );
}
const core = new CoreStack(app, "TabframeCore", {
  env,
  ...(budgetEmail ? { budgetEmail } : {}),
});

const image = new ImageStack(app, "TabframeImage", {
  env,
  core,
  baseImageVersion: String(app.node.tryGetContext("baseImageVersion") ?? "1"),
  // The staged image by default (WP8.2): a bare `cdk deploy` used to publish the placeholder in
  // packages/infra/image as the newest version, which the next rotation would then boot. The
  // placeholder is allowed only when asked for by name.
  stagingDir: stagingDirOrRefuse(),
});

const fleet = new FleetStack(app, "TabframeFleet", {
  ...(budgetEmail ? { alarmEmail: budgetEmail } : {}),
  env,
  core,
  image,
  fleetDir: resolve(repoRoot, "packages/fleet"),
});

// The web bundle must exist for synth; tests point TABFRAME_WEB_DIST at a fixture.
new WebStack(app, "TabframeWeb", {
  env,
  core,
  fleet,
  distDir: process.env.TABFRAME_WEB_DIST ?? resolve(repoRoot, "packages/web/dist"),
});

app.synth();
