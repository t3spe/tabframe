// Fleet stack (design §9.2, §11.4): the session and rotate functions, the hourly rule (created
// disabled), their least-privilege roles, the alarms and the canary.
import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { EnvOf, ROTATE_ENV, SESSION_ENV } from "../../fleet/src/env.ts";
import { NAMES } from "../../fleet/src/names.ts";
import { Canary } from "./canary.ts";
import { fleetFunction } from "./fleet-function.ts";
import type { FoundationStack } from "./foundation-stack.ts";
import { grantMicrovmLauncher, grantMicrovmTokens, grantPassRole, grantPointer } from "./grants.ts";
import type { ImageStack } from "./image-stack.ts";
import { anyImageArn, functionArn, parameterArn, ruleArn } from "./names.ts";

export interface FleetStackProps extends cdk.StackProps {
  /** Where the alarms mail: the budget address, when configured. */
  alarmEmail?: string;
  foundation: FoundationStack;
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
    const { foundation, image } = props;
    const iam = cdk.aws_iam;
    const pointerArn = parameterArn(this, NAMES.pointerParam);

    // Session names rotate by its fixed name, not by resource, so the graph stays acyclic: rotate
    // needs the session URL, session needs only rotate's ARN.
    const sessionEnv: EnvOf<typeof SESSION_ENV> = {
      TABFRAME_POINTER_PARAM: NAMES.pointerParam,
      TABFRAME_STORE_BASE: `${foundation.webOrigin}/blob`,
      TABFRAME_WEB_ORIGIN: foundation.webOrigin,
      TABFRAME_ROTATE_FUNCTION: NAMES.rotateFunction,
    };
    // No reserved concurrency anywhere: the account's Lambda concurrency default of 10 must stay
    // fully unreserved (CloudFormation refuses otherwise). Rotate stays single-writer through its
    // idempotent check and the per-generation client token instead.
    this.session = fleetFunction(this, "Session", {
      functionName: NAMES.sessionFunction,
      entry: `${props.fleetDir}/src/lambda/session.ts`,
      memory: 256,
      timeout: cdk.Duration.seconds(10),
      environment: sessionEnv,
      description: "Tabframe session: vends the control-plane endpoint and a shared token; heals",
    });
    grantMicrovmTokens(this.session, anyImageArn(this));
    grantPointer(this.session, pointerArn, "read");
    this.session.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [functionArn(this, NAMES.rotateFunction)],
      }),
    );
    // CORS is answered by the handler itself (GET and OPTIONS); configuring it on the URL as well
    // would emit the Access-Control-Allow-Origin header twice, which browsers reject.
    this.sessionUrl = this.session.addFunctionUrl({
      authType: cdk.aws_lambda.FunctionUrlAuthType.NONE,
    });

    const rotateEnv: EnvOf<typeof ROTATE_ENV> = {
      TABFRAME_POINTER_PARAM: NAMES.pointerParam,
      TABFRAME_IMAGE_ARN: image.imageArn,
      TABFRAME_CP_ROLE_ARN: image.controlPlaneRole.roleArn,
      TABFRAME_SESSION_URL: this.sessionUrl.url,
      TABFRAME_STORE_BASE: `${foundation.webOrigin}/blob`,
      TABFRAME_FLEET_SECRET_ARN: foundation.fleetSecret.secretArn,
      TABFRAME_SNAPSHOT_BUCKET: foundation.snapshotBucket.bucketName,
    };
    this.rotate = fleetFunction(this, "Rotate", {
      functionName: NAMES.rotateFunction,
      entry: `${props.fleetDir}/src/lambda/rotate.ts`,
      memory: 256,
      // A ready wait of two minutes plus handover, adopt, drain and their retries must not be cut
      // off between the pointer flip and the retire.
      timeout: cdk.Duration.minutes(10),
      environment: rotateEnv,
      description:
        "Tabframe rotate: launches and hands over control planes; the sole pointer writer",
    });
    grantMicrovmLauncher(this.rotate, {
      launchImageArn: image.imageArn,
      anyImageArn: anyImageArn(this),
      mintsTokens: true,
    });
    grantPointer(this.rotate, pointerArn, "readwrite");
    grantPassRole(this.rotate, image.controlPlaneRole);
    foundation.fleetSecret.grantRead(this.rotate);
    foundation.snapshotBucket.grantRead(this.rotate);
    // The rule ARN comes from the fixed name: referencing the Rule construct here would close a
    // cycle (function → policy → rule → function).
    this.rotate.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["events:EnableRule", "events:DisableRule"],
        resources: [ruleArn(this, NAMES.hourlyRule)],
      }),
    );

    this.hourlyRule = new cdk.aws_events.Rule(this, "Hourly", {
      ruleName: NAMES.hourlyRule,
      description: "Tabframe hourly control-plane rotation; `mise run up` enables it",
      schedule: cdk.aws_events.Schedule.rate(cdk.Duration.hours(1)),
      // Created disabled so a deploy never starts rotating on its own; `up` enables it (D20).
      enabled: false,
      targets: [new cdk.aws_events_targets.LambdaFunction(this.rotate)],
    });
    // A rotation that throws is retried twice by the platform within the hour: this is the
    // function's own asynchronous-invoke policy; the rule target's retries govern delivery only.
    this.rotate.configureAsyncInvoke({
      retryAttempts: 2,
      maxEventAge: cdk.Duration.minutes(30),
    });

    // A rotation or a session call that fails is a message to the operator, not a line in a log
    // nobody reads. The topic mails the budget address when one is configured.
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
    new Canary(this, {
      fleetDir: props.fleetDir,
      webOrigin: foundation.webOrigin,
      sessionUrl: this.sessionUrl.url,
      alarms,
    });

    new cdk.CfnOutput(this, "SessionUrl", { value: this.sessionUrl.url });
    new cdk.CfnOutput(this, "SessionFunctionName", { value: this.session.functionName });
    new cdk.CfnOutput(this, "RotateFunctionName", { value: this.rotate.functionName });
    new cdk.CfnOutput(this, "HourlyRuleName", { value: this.hourlyRule.ruleName });
  }
}
