import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { CANARY_ENV, ROTATE_ENV, SESSION_ENV } from "../../fleet/src/env.ts";
import { NAMES } from "../../fleet/src/names.ts";
import { buildApp } from "../lib/app.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const env = { account: "123456789012", region: "us-west-2" };
const PLACEHOLDER_EMAIL = "budget@example.invalid";

function synth(budgetEmail?: string) {
  const { app, foundation, image, fleet, web } = buildApp(
    {
      env,
      budgetEmail: budgetEmail ?? null,
      stagingDir: resolve(repoRoot, "packages/infra/image"),
      fleetDir: resolve(repoRoot, "packages/fleet"),
      // A directory that exists in the repo stands in for the built bundle.
      webDistDir: resolve(repoRoot, "packages/web/public"),
    },
    // Skip esbuild bundling of the fleet functions during tests; the templates are what we assert.
    { "aws:cdk:bundling-stacks": [] },
  );
  const assembly = app.synth();
  return {
    core: Template.fromStack(foundation),
    image: Template.fromStack(image),
    fleet: Template.fromStack(fleet),
    web: Template.fromStack(web),
    assembly,
    foundationStack: foundation,
  };
}

describe("Foundation stack (TabframeCore)", () => {
  const { core, foundationStack } = synth();

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
    const warnings = Annotations.fromStack(foundationStack).findWarning(
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

describe("CloudFront response header policies", () => {
  const { core } = synth();
  test("security headers are never custom headers (CloudFront refuses the policy at deploy time)", () => {
    // `Content-Security-Policy` among the custom headers synthesises fine and fails as
    // CREATE_FAILED; the blob policy's CSP lives in the security headers block.
    const security = new Set([
      "content-security-policy",
      "x-frame-options",
      "x-content-type-options",
      "strict-transport-security",
      "referrer-policy",
      "x-xss-protection",
    ]);
    const policies = core.findResources("AWS::CloudFront::ResponseHeadersPolicy");
    expect(Object.keys(policies).length).toBeGreaterThan(0);
    for (const policy of Object.values(policies)) {
      const custom =
        (
          policy as {
            Properties?: {
              ResponseHeadersPolicyConfig?: {
                CustomHeadersConfig?: { Items?: Array<{ Header: string }> };
              };
            };
          }
        ).Properties?.ResponseHeadersPolicyConfig?.CustomHeadersConfig?.Items ?? [];
      for (const item of custom) expect(security.has(item.Header.toLowerCase())).toBe(false);
    }
    // And the blob policy still sandboxes what it serves.
    core.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: { ContentSecurityPolicy: "sandbox", Override: true },
        }),
      }),
    });
  });
});

describe("Fleet stack", () => {
  const { fleet, image } = synth();

  test("three Node 22 arm64 functions with the design's names and concurrency", () => {
    // Session, rotate and the canary, plus the retention provider CDK adds for `logRetention`.
    fleet.resourceCountIs("AWS::Lambda::Function", 4);
    fleet.resourceCountIs("Custom::LogRetention", 3);
    fleet.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "tabframe-session",
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
    });
    fleet.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "tabframe-rotate",
      Timeout: 600,
    });
  });

  test("each function's environment is exactly the keys its loader reads", () => {
    const fns = Object.values(fleet.findResources("AWS::Lambda::Function"));
    const envKeys = (name: string) => {
      const fn = fns.find((f) => f.Properties?.FunctionName === name);
      const vars = fn?.Properties?.Environment?.Variables as Record<string, unknown> | undefined;
      return Object.keys(vars ?? {}).sort();
    };
    expect(envKeys(NAMES.sessionFunction)).toEqual([...SESSION_ENV].sort());
    expect(envKeys(NAMES.rotateFunction)).toEqual([...ROTATE_ENV].sort());
    expect(envKeys(NAMES.canaryFunction)).toEqual([...CANARY_ENV].sort());
  });

  test("the canary runs every five minutes, may only write metrics, and its alarms mail the topic", () => {
    fleet.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "tabframe-canary",
      MemorySize: 128,
      Timeout: 10,
    });
    fleet.hasResourceProperties("AWS::Events::Rule", { ScheduleExpression: "rate(5 minutes)" });
    // Its policy names CloudWatch only: never a MicroVM action, so it cannot wake the machine.
    const policies = fleet.findResources("AWS::IAM::Policy");
    const canaryPolicy = Object.entries(policies).find(([id]) => id.startsWith("Canary"));
    expect(canaryPolicy).toBeDefined();
    const statements = JSON.stringify(canaryPolicy?.[1]);
    expect(statements).toContain("cloudwatch:PutMetricData");
    expect(statements).not.toContain("lambda-microvms");
    for (const name of ["PageOk", "SessionOk", "Starting"]) {
      fleet.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Namespace: "Tabframe/Canary",
        MetricName: name,
      });
    }
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
    // The launchers may run the Tabframe image only: no RunMicrovm statement in either stack names
    // a wildcard image.
    for (const resources of [runMicrovmResources(fleet), runMicrovmResources(image)]) {
      expect(resources.length).toBeGreaterThan(0);
      for (const r of resources) expect(r).not.toContain("microvm-image:*");
    }
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

  test("the address that configures the budget also subscribes it to the alarms", () => {
    const { fleet } = synth(PLACEHOLDER_EMAIL);
    fleet.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "email",
      Endpoint: PLACEHOLDER_EMAIL,
    });
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

/** The stringified Resource of every IAM statement that grants lambda:RunMicrovm. */
function runMicrovmResources(template: Template): string[] {
  const out: string[] = [];
  for (const policy of Object.values(template.findResources("AWS::IAM::Policy"))) {
    const doc = (policy as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } })
      .Properties?.PolicyDocument?.Statement;
    for (const st of doc ?? []) {
      const actions = JSON.stringify((st as { Action?: unknown }).Action ?? "");
      if (actions.includes("lambda:RunMicrovm"))
        out.push(JSON.stringify((st as { Resource?: unknown }).Resource ?? ""));
    }
  }
  return out;
}
