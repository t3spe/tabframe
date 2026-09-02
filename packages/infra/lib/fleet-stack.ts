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
      // The runtime's built-in SDK predates client-lambda-microvms; bundle the SDK we import.
      bundleAwsSDK: true,
      mainFields: ["module", "main"],
      banner:
        "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    };

    const pointerArn = parameterArn(this, NAMES.pointerParam);
    const microvmActionsOnImages = (actions: string[]) =>
      new iam.PolicyStatement({ actions, resources: [anyImageArn(this)] });

    // session references rotate by its fixed name, not by resource, so the graph stays acyclic:
    // rotate needs the session URL, session needs only rotate's ARN.
    // Named log groups with a retention the budget can live with; without them Lambda creates
    // groups that keep everything forever.
    const logs = cdk.aws_logs;
    const sessionLogs = new logs.LogGroup(this, "SessionLogs", {
      logGroupName: `/aws/lambda/${NAMES.sessionFunction}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const rotateLogs = new logs.LogGroup(this, "RotateLogs", {
      logGroupName: `/aws/lambda/${NAMES.rotateFunction}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.session = new nodejs.NodejsFunction(this, "Session", {
      logGroup: sessionLogs,
      functionName: NAMES.sessionFunction,
      entry: `${props.fleetDir}/src/lambda/session.ts`,
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      // No reserved concurrency: the account's Lambda concurrency default of 10 must stay fully
      // unreserved (CloudFormation refuses otherwise). Rotate stays single-writer through its
      // idempotent check and the per-generation client token instead.
      bundling,
      environment: {
        TABFRAME_POINTER_PARAM: NAMES.pointerParam,
        TABFRAME_STORE_BASE: `${core.webOrigin}/blob`,
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
    // CORS is answered by the handler itself (GET and OPTIONS); configuring it on the URL as well
    // would emit the Access-Control-Allow-Origin header twice, which browsers reject.
    this.sessionUrl = this.session.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    this.rotate = new nodejs.NodejsFunction(this, "Rotate", {
      logGroup: rotateLogs,
      functionName: NAMES.rotateFunction,
      entry: `${props.fleetDir}/src/lambda/rotate.ts`,
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.minutes(5),
      bundling,
      environment: {
        TABFRAME_POINTER_PARAM: NAMES.pointerParam,
        TABFRAME_IMAGE_ARN: image.imageArn,
        TABFRAME_CP_ROLE_ARN: image.controlPlaneRole.roleArn,
        TABFRAME_SESSION_URL: this.sessionUrl.url,
        TABFRAME_STORE_BASE: `${core.webOrigin}/blob`,
        TABFRAME_FLEET_SECRET_ARN: core.fleetSecret.secretArn,
        TABFRAME_SNAPSHOT_BUCKET: core.snapshotBucket.bucketName,
      },
      description:
        "Tabframe rotate: launches and hands over control planes; the sole pointer writer",
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
        // The managed connectors live in the "aws" account; a wildcard on their ARN pattern was still
        // denied at deploy, so this action is granted on "*".
        actions: ["lambda:PassNetworkConnector"],
        resources: ["*"],
      }),
    );
    this.rotate.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter"],
        resources: [pointerArn],
      }),
    );
    this.rotate.addToRolePolicy(
      new iam.PolicyStatement({
        // PassRole is limited to the one role; a PassedToService condition is not honored by RunMicrovm.
        actions: ["iam:PassRole"],
        resources: [image.controlPlaneRole.roleArn],
      }),
    );
    core.fleetSecret.grantRead(this.rotate);
    core.snapshotBucket.grantRead(this.rotate);

    this.hourlyRule = new cdk.aws_events.Rule(this, "Hourly", {
      ruleName: NAMES.hourlyRule,
      description: "Tabframe hourly control-plane rotation; `mise run up` enables it",
      schedule: cdk.aws_events.Schedule.rate(cdk.Duration.hours(1)),
      // Created disabled so a deploy never starts rotating on its own; `up` enables it (D20).
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
