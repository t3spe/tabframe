import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { CoreStack } from "../lib/core-stack.ts";
import { FleetStack } from "../lib/fleet-stack.ts";
import { ImageStack } from "../lib/image-stack.ts";
import { WebStack } from "../lib/web-stack.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const env = { account: "123456789012", region: "us-west-2" };
const PLACEHOLDER_EMAIL = "budget@example.invalid";

function synth(budgetEmail?: string) {
  const app = new cdk.App({
    // Skip esbuild bundling of the fleet functions during tests; the templates are what we assert.
    context: { "aws:cdk:bundling-stacks": [] },
  });
  const core = new CoreStack(app, "TabframeCore", { env, ...(budgetEmail ? { budgetEmail } : {}) });
  const image = new ImageStack(app, "TabframeImage", {
    env,
    core,
    baseImageVersion: "1",
    stagingDir: resolve(repoRoot, "packages/infra/image"),
  });
  const fleet = new FleetStack(app, "TabframeFleet", {
    env,
    core,
    image,
    fleetDir: resolve(repoRoot, "packages/fleet"),
  });
  const web = new WebStack(app, "TabframeWeb", {
    env,
    core,
    fleet,
    // A directory that exists in the repo stands in for the built bundle.
    distDir: resolve(repoRoot, "packages/web/public"),
  });
  const assembly = app.synth();
  return {
    core: Template.fromStack(core),
    image: Template.fromStack(image),
    fleet: Template.fromStack(fleet),
    web: Template.fromStack(web),
    assembly,
    coreStack: core,
  };
}

describe("Core stack", () => {
  const { core, coreStack } = synth();

  test("four private buckets, one with a one-year lifecycle and browser PUT CORS", () => {
    core.resourceCountIs("AWS::S3::Bucket", 4);
    core.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: [Match.objectLike({ ExpirationInDays: 365, Status: "Enabled" })],
      },
      CorsConfiguration: {
        CorsRules: [
          Match.objectLike({ AllowedMethods: ["GET", "HEAD", "PUT"], AllowedHeaders: ["*"] }),
        ],
      },
    });
    core.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: { Rules: [Match.objectLike({ ExpirationInDays: 1 })] },
    });
    core.allResourcesProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: Match.objectLike({
        BlockPublicAcls: true,
        RestrictPublicBuckets: true,
      }),
    });
  });

  test("one distribution with a blob behavior and zero error caching", () => {
    core.resourceCountIs("AWS::CloudFront::Distribution", 1);
    core.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: "index.html",
        CacheBehaviors: [Match.objectLike({ PathPattern: "blob/*", Compress: false })],
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({ ErrorCode: 403, ErrorCachingMinTTL: 0 }),
          Match.objectLike({ ErrorCode: 404, ErrorCachingMinTTL: 0 }),
        ]),
      }),
    });
  });

  test("the pointer starts off and the fleet secret is generated", () => {
    core.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/tabframe/pointer",
      Type: "String",
      Value: '{"state":"off"}',
    });
    core.resourceCountIs("AWS::SecretsManager::Secret", 1);
  });

  test("without an address the budget is skipped with a warning and no placeholder leaks", () => {
    core.resourceCountIs("AWS::Budgets::Budget", 0);
    expect(JSON.stringify(core.toJSON())).not.toContain("@");
    const warnings = Annotations.fromStack(coreStack).findWarning(
      "*",
      Match.stringLikeRegexp("TABFRAME_BUDGET_EMAIL"),
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("with an address the $100 budget has four notifications", () => {
    const { core: withBudget } = synth(PLACEHOLDER_EMAIL);
    withBudget.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: Match.objectLike({
        BudgetType: "COST",
        TimeUnit: "MONTHLY",
        BudgetLimit: { Amount: 100, Unit: "USD" },
      }),
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({
          Notification: Match.objectLike({ NotificationType: "ACTUAL", Threshold: 50 }),
        }),
        Match.objectLike({
          Notification: Match.objectLike({ NotificationType: "ACTUAL", Threshold: 80 }),
        }),
        Match.objectLike({
          Notification: Match.objectLike({ NotificationType: "ACTUAL", Threshold: 100 }),
        }),
        Match.objectLike({
          Notification: Match.objectLike({ NotificationType: "FORECASTED", Threshold: 100 }),
        }),
      ]),
    });
  });
});

describe("Image stack", () => {
  const { image } = synth();

  test("one MicroVM image with hooks on the private port, arm64, the managed base image, and only image-local env", () => {
    image.resourceCountIs("AWS::Lambda::MicrovmImage", 1);
    image.hasResourceProperties("AWS::Lambda::MicrovmImage", {
      Name: "tabframe",
      BaseImageArn: "arn:aws:lambda:us-west-2:aws:microvm-image:al2023-1",
      BaseImageVersion: "1",
      CpuConfigurations: [{ Architecture: "ARM_64" }],
      Resources: [{ MinimumMemoryInMiB: 1024 }],
      Hooks: Match.objectLike({
        Port: 8081,
        MicrovmImageHooks: Match.objectLike({ Ready: "ENABLED", Validate: "ENABLED" }),
        MicrovmHooks: Match.objectLike({
          Run: "ENABLED",
          Resume: "ENABLED",
          Suspend: "ENABLED",
          Terminate: "ENABLED",
        }),
      }),
      CodeArtifact: { Uri: Match.stringLikeRegexp("^s3://") },
    });
    const [props] = Object.values(image.findResources("AWS::Lambda::MicrovmImage")).map(
      (r) => r.Properties,
    );
    const keys = (props.EnvironmentVariables as { Key: string }[]).map((v) => v.Key);
    expect(keys).toContain("TABFRAME_BLOB_BUCKET");
    expect(keys).toContain("TABFRAME_POINTER_PARAM");
    expect(keys.some((k) => /SESSION|FLEET_SECRET|ROTATE/.test(k))).toBe(false);
  });

  test("three roles trusted by lambda.amazonaws.com with AssumeRole and TagSession", () => {
    image.resourceCountIs("AWS::IAM::Role", 3);
    image.allResourcesProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["sts:AssumeRole", "sts:TagSession"]),
            Principal: { Service: "lambda.amazonaws.com" },
          }),
        ]),
      }),
    });
  });

  test("the control-plane role can pass only the core role, and the core role has no MicroVM actions", () => {
    const policies = Object.values(image.findResources("AWS::IAM::Policy")).map((p) =>
      JSON.stringify(p.Properties),
    );
    expect(policies.some((p) => p.includes("iam:PassRole") && p.includes("CoreRole"))).toBe(true);
    const coreRolePolicy = policies.filter((p) => p.includes('"Roles":[{"Ref":"CoreRole'));
    expect(coreRolePolicy.length).toBe(1);
    expect(coreRolePolicy[0]).not.toContain("lambda:RunMicrovm");
  });
});

describe("Fleet stack", () => {
  const { fleet } = synth();

  test("two Node 22 arm64 functions with the design's names and concurrency", () => {
    fleet.resourceCountIs("AWS::Lambda::Function", 2);
    fleet.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "tabframe-session",
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
    });
    fleet.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "tabframe-rotate",
      Timeout: 300,
      Environment: {
        Variables: Match.objectLike({
          TABFRAME_SESSION_URL: Match.anyValue(),
          TABFRAME_FLEET_SECRET_ARN: Match.anyValue(),
        }),
      },
    });
  });

  test("a public function URL without URL-level CORS (the handler answers it), and an hourly rule created disabled", () => {
    fleet.hasResourceProperties("AWS::Lambda::Url", { AuthType: "NONE" });
    const urls = Object.values(fleet.findResources("AWS::Lambda::Url"));
    expect(urls.length).toBe(1);
    expect(urls[0]?.Properties?.Cors).toBeUndefined();
    // The store base handed to clients is the blob prefix behind CloudFront.
    const fns = Object.values(fleet.findResources("AWS::Lambda::Function"));
    for (const fn of fns) {
      const vars = fn.Properties?.Environment?.Variables as Record<string, unknown> | undefined;
      if (vars?.TABFRAME_STORE_BASE)
        expect(JSON.stringify(vars.TABFRAME_STORE_BASE)).toContain("/blob");
    }
    fleet.hasResourceProperties("AWS::Events::Rule", {
      Name: "tabframe-rotate-hourly",
      ScheduleExpression: "rate(1 hour)",
      State: "DISABLED",
    });
  });

  test("session may invoke rotate but may not run MicroVMs", () => {
    const policies = Object.values(fleet.findResources("AWS::IAM::Policy")).map((p) =>
      JSON.stringify(p.Properties),
    );
    const sessionPolicy = policies.find((p) => p.includes("SessionServiceRole"));
    expect(sessionPolicy).toContain("lambda:InvokeFunction");
    expect(sessionPolicy).toContain("lambda:CreateMicrovmAuthToken");
    expect(sessionPolicy).not.toContain("lambda:RunMicrovm");
    const rotatePolicy = policies.find((p) => p.includes("RotateServiceRole"));
    expect(rotatePolicy).toContain("lambda:RunMicrovm");
    expect(rotatePolicy).toContain("ssm:PutParameter");
    expect(rotatePolicy).toContain("secretsmanager:GetSecretValue");
  });
});

describe("assembly", () => {
  test("stacks depend Core → Image → Fleet and nothing else", () => {
    const { assembly } = synth();
    const deps = Object.fromEntries(
      assembly.stacks.map((s) => [
        s.stackName,
        s.dependencies
          .map((d) => d.id)
          .filter((id) => !id.endsWith(".assets"))
          .sort(),
      ]),
    );
    expect(deps.TabframeCore).toEqual([]);
    expect(deps.TabframeImage).toEqual(["TabframeCore"]);
    expect(deps.TabframeFleet).toEqual(["TabframeCore", "TabframeImage"]);
    expect(deps.TabframeWeb).toEqual(["TabframeCore", "TabframeFleet"]);
  });
});

describe("Web stack", () => {
  const { web, image } = synth();
  test("deploys the bundle plus a config.json naming the session URL and invalidates the distribution", () => {
    web.hasResourceProperties("Custom::CDKBucketDeployment", {
      DistributionPaths: ["/*"],
      Prune: true,
    });
    const deployments = Object.values(web.findResources("Custom::CDKBucketDeployment"));
    expect(deployments.length).toBe(1);
    // Two sources: the bundle asset and the generated config.json, whose session URL is a deploy-time
    // token substituted through SourceMarkers.
    const props = deployments[0]?.Properties as { SourceObjectKeys?: unknown[] } | undefined;
    expect(props?.SourceObjectKeys?.length).toBe(2);
    expect(JSON.stringify(props)).toContain("SourceMarkers");
  });
  test("the image runs in image mode bound to all interfaces", () => {
    const images = Object.values(image.findResources("AWS::Lambda::MicrovmImage"));
    const vars = images[0]?.Properties?.EnvironmentVariables as Array<{
      Key: string;
      Value: string;
    }>;
    const byKey = Object.fromEntries(vars.map((v) => [v.Key, v.Value]));
    expect(byKey.TABFRAME_MODE).toBe("image");
    expect(byKey.TABFRAME_HOST).toBe("0.0.0.0");
  });
});
