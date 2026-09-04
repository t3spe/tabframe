// Names and ARN helpers shared by the stacks. Explicit names break what would otherwise be
// token cycles (session → rotate → session URL) and give the operator scripts stable targets.
import * as cdk from "aws-cdk-lib";

export const NAMES = {
  alarmTopic: "tabframe-alarms",
  canaryFunction: "tabframe-canary",
  imageName: "tabframe",
  sessionFunction: "tabframe-session",
  rotateFunction: "tabframe-rotate",
  hourlyRule: "tabframe-rotate-hourly",
  pointerParam: "/tabframe/pointer",
  microvmLogGroup: "/aws/lambda/microvms/tabframe",
  baseImageName: "al2023-1",
} as const;

export const PORTS = { public: 8080, private: 8081 } as const;

export const HOOK_BASE = "/aws/lambda-microvms/runtime/v1";

export function baseImageArn(stack: cdk.Stack): string {
  return `arn:aws:lambda:${stack.region}:aws:microvm-image:${NAMES.baseImageName}`;
}

export function managedConnectorArn(
  stack: cdk.Stack,
  id: "ALL_INGRESS" | "INTERNET_EGRESS" | "NO_INGRESS",
): string {
  return `arn:aws:lambda:${stack.region}:aws:network-connector:aws-network-connector:${id}`;
}

/** The image ARN is deterministic from the name, so stacks can reference it without an attribute. */
export function imageArn(stack: cdk.Stack): string {
  return stack.formatArn({
    service: "lambda",
    resource: "microvm-image",
    resourceName: NAMES.imageName,
    arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
  });
}

/** Any MicroVM image in this account and region; MicroVM actions are authorized against image ARNs. */
export function anyImageArn(stack: cdk.Stack): string {
  return stack.formatArn({
    service: "lambda",
    resource: "microvm-image",
    resourceName: "*",
    arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
  });
}

export function functionArn(stack: cdk.Stack, functionName: string): string {
  return stack.formatArn({
    service: "lambda",
    resource: "function",
    resourceName: functionName,
    arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
  });
}

/** By name rather than from the Rule construct: the rule targets rotate, and rotate's policy names the rule. */
export function ruleArn(stack: cdk.Stack, ruleName: string): string {
  return stack.formatArn({
    service: "events",
    resource: "rule",
    resourceName: ruleName,
    arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
  });
}

export function parameterArn(stack: cdk.Stack, name: string): string {
  return stack.formatArn({
    service: "ssm",
    resource: "parameter",
    resourceName: name.replace(/^\//, ""),
    arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
  });
}

/** Every AWS-managed network connector; RunMicrovm needs lambda:PassNetworkConnector on the ones it passes. */
export function anyManagedConnectorArn(stack: cdk.Stack): string {
  return `arn:aws:lambda:${stack.region}:aws:network-connector:aws-network-connector:*`;
}
