// Fleet stack (design §9.2, §11.4): the session and rotate functions, the hourly rule (created
// disabled), and their least-privilege roles.
import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { CoreStack } from "./core-stack.ts";
import type { ImageStack } from "./image-stack.ts";
import { anyImageArn, functionArn, NAMES, parameterArn, ruleArn } from "./names.ts";

export interface FleetStackProps extends cdk.StackProps {
  /** Where the alarms mail (WP8.1); the budget address, when configured. */
  alarmEmail?: string;
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
    // Launches are allowed from the Tabframe image only (WP8.2: loop 1's version only applied to a
    // single-action statement, which no caller used); the other MicroVM actions keep the image-wide
    // resource until the API's resource model for a MicroVM is pinned down.
    const microvmActionsOnImages = (actions: string[]) => {
      const run = actions.filter((a) => a === "lambda:RunMicrovm");
      const rest = actions.filter((a) => a !== "lambda:RunMicrovm");
      const statements: cdk.aws_iam.PolicyStatement[] = [];
      if (run.length)
        statements.push(new iam.PolicyStatement({ actions: run, resources: [image.imageArn] }));
      if (rest.length)
        statements.push(new iam.PolicyStatement({ actions: rest, resources: [anyImageArn(this)] }));
      return statements;
    };

    // session references rotate by its fixed name, not by resource, so the graph stays acyclic:
    // rotate needs the session URL, session needs only rotate's ARN.
    // Lambda created the two functions' log groups on their first invocation, before any stack
    // owned them, so the stack cannot create them (already exists); it sets their retention
    // instead. Fourteen days is what the budget can live with.
    const logRetention = cdk.aws_logs.RetentionDays.TWO_WEEKS;
    this.session = new nodejs.NodejsFunction(this, "Session", {
      logRetention,
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
    for (const st of microvmActionsOnImages(["lambda:CreateMicrovmAuthToken", "lambda:GetMicrovm"]))
      this.session.addToRolePolicy(st);
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
      logRetention,
      functionName: NAMES.rotateFunction,
      entry: `${props.fleetDir}/src/lambda/rotate.ts`,
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      // Ten minutes (WP8.2): a ready wait of two minutes plus handover, adopt, drain, and their
      // retries must not be cut off between the pointer flip and the retire.
      timeout: cdk.Duration.minutes(10),
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
    for (const st of microvmActionsOnImages([
      "lambda:RunMicrovm",
      "lambda:GetMicrovm",
      "lambda:TerminateMicrovm",
      "lambda:CreateMicrovmAuthToken",
      "lambda:GetMicrovmImage",
    ]))
      this.rotate.addToRolePolicy(st);
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
    // A rotation that throws is retried twice by the platform within the hour (WP8.2: this is the
    // function's own asynchronous-invoke policy; the rule target's retries govern delivery only).
    this.rotate.configureAsyncInvoke({
      retryAttempts: 2,
      maxEventAge: cdk.Duration.minutes(30),
    });
    // Alarms (WP8.1): a rotation or a session call that fails is a message to the operator, not
    // a line in a log nobody reads. The topic mails the budget address when one is configured.
    const alarms = new cdk.aws_sns.Topic(this, "Alarms", { topicName: NAMES.alarmTopic });
    if (props.alarmEmail)
      alarms.addSubscription(new cdk.aws_sns_subscriptions.EmailSubscription(props.alarmEmail));
    const alarmOn = (id: string, metric: cdk.aws_cloudwatch.Metric, description: string) => {
      const alarm = new cdk.aws_cloudwatch.Alarm(this, id, {
        alarmDescription: description,
        metric,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          cdk.aws_cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(alarms));
      return alarm;
    };
    alarmOn(
      "RotateErrors",
      this.rotate.metricErrors({ period: cdk.Duration.minutes(5) }),
      "Tabframe: the rotate function failed (a rotation, heal, or up did not complete)",
    );
    alarmOn(
      "SessionErrors",
      this.session.metricErrors({ period: cdk.Duration.minutes(5) }),
      "Tabframe: the session function failed (visitors cannot find the control plane)",
    );
    alarmOn(
      "RotateThrottles",
      this.rotate.metricThrottles({ period: cdk.Duration.minutes(5) }),
      "Tabframe: the rotate function was throttled (the account's Lambda pool is busy)",
    );

    // A synthetic canary (WP8.2): every five minutes it fetches the page's config and asks the
    // session function, and records what it saw. It never touches the MicroVM endpoint — that is
    // idle-policy traffic and would keep a suspended machine awake all night — so "starting" for
    // three periods running is the signal that a heal is stuck.
    const canary = new nodejs.NodejsFunction(this, "Canary", {
      logRetention,
      functionName: NAMES.canaryFunction,
      entry: `${props.fleetDir}/src/lambda/canary.ts`,
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 128,
      timeout: cdk.Duration.seconds(10),
      bundling,
      environment: {
        TABFRAME_WEB_ORIGIN: core.webOrigin,
        TABFRAME_SESSION_URL: this.sessionUrl.url,
      },
    });
    canary.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["cloudwatch:PutMetricData"], resources: ["*"] }),
    );
    new cdk.aws_events.Rule(this, "CanaryEvery5", {
      schedule: cdk.aws_events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new cdk.aws_events_targets.LambdaFunction(canary)],
    });
    const canaryMetric = (name: string) =>
      new cdk.aws_cloudwatch.Metric({
        namespace: "Tabframe/Canary",
        metricName: name,
        statistic: "Minimum",
        period: cdk.Duration.minutes(5),
      });
    for (const [id, name, description] of [
      [
        "PageDown",
        "PageOk",
        "Tabframe: the page's config.json did not answer for two of three checks",
      ],
      [
        "SessionDown",
        "SessionOk",
        "Tabframe: the session function did not answer for two of three checks",
      ],
    ] as const) {
      const alarm = new cdk.aws_cloudwatch.Alarm(this, id, {
        alarmDescription: description,
        metric: canaryMetric(name),
        threshold: 1,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        comparisonOperator: cdk.aws_cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cdk.aws_cloudwatch.TreatMissingData.BREACHING,
      });
      alarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(alarms));
    }
    const stuck = new cdk.aws_cloudwatch.Alarm(this, "StuckStarting", {
      alarmDescription:
        "Tabframe: the session has said 'starting' for fifteen minutes — a heal is stuck",
      metric: canaryMetric("Starting"),
      threshold: 1,
      evaluationPeriods: 3,
      comparisonOperator: cdk.aws_cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    stuck.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(alarms));
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
