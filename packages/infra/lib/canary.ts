// The synthetic canary: every five minutes it fetches the page's config and asks the session
// function, and records what it saw. It never touches the MicroVM endpoint — that is idle-policy
// traffic and would keep a suspended machine awake all night — so "starting" for three periods
// running is the signal that a heal is stuck.
import * as cdk from "aws-cdk-lib";
import type { CANARY_ENV, EnvOf } from "../../fleet/src/env.ts";
import { NAMES } from "../../fleet/src/names.ts";
import { fleetFunction } from "./fleet-function.ts";

export interface CanaryProps {
  fleetDir: string;
  webOrigin: string;
  sessionUrl: string;
  /** Where the alarms go. */
  alarms: cdk.aws_sns.ITopic;
}

/**
 * The canary's function, schedule, metrics and alarms. Not a Construct of its own: the function is
 * named, and moving its resources under a child scope would change their logical ids and make
 * CloudFormation replace a named function it cannot create twice.
 */
export class Canary {
  readonly fn: cdk.aws_lambda_nodejs.NodejsFunction;
  readonly rule: cdk.aws_events.Rule;
  readonly alarms: cdk.aws_cloudwatch.Alarm[];

  constructor(stack: cdk.Stack, props: CanaryProps) {
    const cw = cdk.aws_cloudwatch;
    const environment: EnvOf<typeof CANARY_ENV> = {
      TABFRAME_WEB_ORIGIN: props.webOrigin,
      TABFRAME_SESSION_URL: props.sessionUrl,
    };
    this.fn = fleetFunction(stack, "Canary", {
      functionName: NAMES.canaryFunction,
      entry: `${props.fleetDir}/src/lambda/canary.ts`,
      memory: 128,
      timeout: cdk.Duration.seconds(10),
      environment,
    });
    this.fn.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({ actions: ["cloudwatch:PutMetricData"], resources: ["*"] }),
    );
    this.rule = new cdk.aws_events.Rule(stack, "CanaryEvery5", {
      schedule: cdk.aws_events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new cdk.aws_events_targets.LambdaFunction(this.fn)],
    });
    const metric = (name: string) =>
      new cw.Metric({
        namespace: "Tabframe/Canary",
        metricName: name,
        statistic: "Minimum",
        period: cdk.Duration.minutes(5),
      });
    const down = (id: string, name: string, description: string) =>
      new cw.Alarm(stack, id, {
        alarmDescription: description,
        metric: metric(name),
        threshold: 1,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cw.TreatMissingData.BREACHING,
      });
    this.alarms = [
      down(
        "PageDown",
        "PageOk",
        "Tabframe: the page's config.json did not answer for two of three checks",
      ),
      down(
        "SessionDown",
        "SessionOk",
        "Tabframe: the session function did not answer for two of three checks",
      ),
      new cw.Alarm(stack, "StuckStarting", {
        alarmDescription:
          "Tabframe: the session has said 'starting' for fifteen minutes — a heal is stuck",
        metric: metric("Starting"),
        threshold: 1,
        evaluationPeriods: 3,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }),
    ];
    for (const alarm of this.alarms) {
      alarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(props.alarms));
    }
  }
}
