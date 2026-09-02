// Fleet stack (design §9.2, §11.4): the session and rotate functions, the hourly rule (created
// disabled), and their least-privilege roles.
import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { CoreStack } from "./core-stack.ts";
import type { ImageStack } from "./image-stack.ts";
import { anyImageArn, functionArn, NAMES, parameterArn, ruleArn } from "./names.ts";

export interface FleetStackProps extends cdk.StackProps {
  core: CoreStack;
  image: ImageStack;
  /** Directory holding packages/fleet (for the Lambda entry files). */
  fleetDir: string;
}

export class FleetStack extends cdk.Stack {
  readonly session: cdk.aws_lambda_nodejs.NodejsFunction;
  readonly rotate: cdk.aws_lambda_nodejs.NodejsFunction;
  readonly sessionUrl: cdk.aws_lambda.FunctionUrl;
  readonly hourlyRule: cdk.aws_events.Rule;

  constructor(scope: Construct, id: string, props: FleetStackProps) {
    super(scope, id, props);
    const { core, image } = props;
    const iam = cdk.aws_iam;
    const lambda = cdk.aws_lambda;
    const nodejs = cdk.aws_lambda_nodejs;

    const bundling: cdk.aws_lambda_nodejs.BundlingOptions = {
      format: nodejs.OutputFormat.ESM,
      target: "node22",
      mainFields: ["module", "main"],
      banner:
        "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    };

    const pointerArn = parameterArn(this, NAMES.pointerParam);
    const microvmActionsOnImages = (actions: string[]) =>
      new iam.PolicyStatement({ actions, resources: [anyImageArn(this)] });

    // session references rotate by its fixed name, not by resource, so the graph stays acyclic:
    // rotate needs the session URL, session needs only rotate's ARN.
    this.session = new nodejs.NodejsFunction(this, "Session", {
      functionName: NAMES.sessionFunction,
      entry: `${props.fleetDir}/src/lambda/session.ts`,
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      reservedConcurrentExecutions: 5,
      bundling,
      environment: {
        TABFRAME_POINTER_PARAM: NAMES.pointerParam,
        TABFRAME_STORE_BASE: core.webOrigin,
        TABFRAME_WEB_ORIGIN: core.webOrigin,
        TABFRAME_ROTATE_FUNCTION: NAMES.rotateFunction,
      },
      description: "Tabframe session: vends the control-plane endpoint and a shared token; heals",
    });
    this.session.addToRolePolicy(
      microvmActionsOnImages(["lambda:CreateMicrovmAuthToken", "lambda:GetMicrovm"]),
    );
    this.session.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["ssm:GetParameter"], resources: [pointerArn] }),
    );
    this.session.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [functionArn(this, NAMES.rotateFunction)],
      }),
    );
    this.sessionUrl = this.session.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: [core.webOrigin],
        allowedMethods: [lambda.HttpMethod.GET],
        allowedHeaders: ["content-type"],
        maxAge: cdk.Duration.hours(1),
      },
    });

    this.rotate = new nodejs.NodejsFunction(this, "Rotate", {
      functionName: NAMES.rotateFunction,
      entry: `${props.fleetDir}/src/lambda/rotate.ts`,
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 1,
      bundling,
      environment: {
        TABFRAME_POINTER_PARAM: NAMES.pointerParam,
        TABFRAME_IMAGE_ARN: image.imageArn,
        TABFRAME_CP_ROLE_ARN: image.controlPlaneRole.roleArn,
        TABFRAME_SESSION_URL: this.sessionUrl.url,
        TABFRAME_STORE_BASE: core.webOrigin,
        TABFRAME_FLEET_SECRET_ARN: core.fleetSecret.secretArn,
      },
      description:
        "Tabframe rotate: launches and (from M3) hands over control planes; sole pointer writer",
    });
    this.rotate.addToRolePolicy(
      microvmActionsOnImages([
        "lambda:RunMicrovm",
        "lambda:GetMicrovm",
        "lambda:TerminateMicrovm",
        "lambda:CreateMicrovmAuthToken",
        "lambda:GetMicrovmImage",
      ]),
    );
    this.rotate.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["lambda:ListMicrovms"], resources: ["*"] }),
    );
    this.rotate.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter"],
        resources: [pointerArn],
      }),
    );
    this.rotate.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [image.controlPlaneRole.roleArn],
        conditions: { StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" } },
      }),
    );
    core.fleetSecret.grantRead(this.rotate);
    core.snapshotBucket.grantRead(this.rotate);

    this.hourlyRule = new cdk.aws_events.Rule(this, "Hourly", {
      ruleName: NAMES.hourlyRule,
      description: "Tabframe hourly control-plane rotation (enabled at M3)",
      schedule: cdk.aws_events.Schedule.rate(cdk.Duration.hours(1)),
      enabled: false,
      targets: [new cdk.aws_events_targets.LambdaFunction(this.rotate)],
    });
    // The rule ARN comes from the fixed name: referencing the Rule construct here would close a
    // cycle (function → policy → rule → function).
    this.rotate.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["events:EnableRule", "events:DisableRule"],
        resources: [ruleArn(this, NAMES.hourlyRule)],
      }),
    );

    new cdk.CfnOutput(this, "SessionUrl", { value: this.sessionUrl.url });
    new cdk.CfnOutput(this, "SessionFunctionName", { value: this.session.functionName });
    new cdk.CfnOutput(this, "RotateFunctionName", { value: this.rotate.functionName });
    new cdk.CfnOutput(this, "HourlyRuleName", { value: this.hourlyRule.ruleName });
  }
}
