// The CDK app: four stacks in dependency order, Core → Image → Fleet → Web (design §11.4).
import * as cdk from "aws-cdk-lib";
import type { AppConfig } from "./app-config.ts";
import { FleetStack } from "./fleet-stack.ts";
import { FoundationStack } from "./foundation-stack.ts";
import { ImageStack } from "./image-stack.ts";
import { WebStack } from "./web-stack.ts";

export interface TabframeApp {
  app: cdk.App;
  foundation: FoundationStack;
  image: ImageStack;
  fleet: FleetStack;
  web: WebStack;
}

/** The four stacks on one app. `context` stands in for what the CLI passes from cdk.json. */
export function buildApp(config: AppConfig, context?: Record<string, unknown>): TabframeApp {
  const app = new cdk.App(context ? { context } : undefined);
  const { env, budgetEmail } = config;
  const foundation = new FoundationStack(app, "TabframeCore", {
    env,
    ...(budgetEmail ? { budgetEmail } : {}),
  });
  const image = new ImageStack(app, "TabframeImage", {
    env,
    foundation,
    baseImageVersion: String(app.node.tryGetContext("baseImageVersion") ?? "1"),
    stagingDir: config.stagingDir,
  });
  const fleet = new FleetStack(app, "TabframeFleet", {
    ...(budgetEmail ? { alarmEmail: budgetEmail } : {}),
    env,
    foundation,
    image,
    fleetDir: config.fleetDir,
  });
  const web = new WebStack(app, "TabframeWeb", {
    env,
    foundation,
    fleet,
    distDir: config.webDistDir,
  });
  return { app, foundation, image, fleet, web };
}
