// One shape for the fleet's Lambda functions: Node 22 on arm64, bundled by esbuild with the SDK,
// two weeks of logs.
import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";

const BUNDLING: cdk.aws_lambda_nodejs.BundlingOptions = {
  format: cdk.aws_lambda_nodejs.OutputFormat.ESM,
  target: "node22",
  // The runtime's built-in SDK predates client-lambda-microvms; bundle the SDK we import.
  bundleAwsSDK: true,
  mainFields: ["module", "main"],
  banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
};

export interface FleetFunctionProps {
  functionName: string;
  /** The Lambda entry file under packages/fleet. */
  entry: string;
  memory: number;
  timeout: cdk.Duration;
  environment: Record<string, string>;
  description?: string;
}

/**
 * A fleet function. `logRetention` rather than a log group of the stack's own: Lambda created the
 * functions' log groups on their first invocation, before any stack owned them, so the stack can
 * only set their retention — two weeks, what the budget can live with.
 */
export function fleetFunction(
  scope: Construct,
  id: string,
  props: FleetFunctionProps,
): cdk.aws_lambda_nodejs.NodejsFunction {
  return new cdk.aws_lambda_nodejs.NodejsFunction(scope, id, {
    logRetention: cdk.aws_logs.RetentionDays.TWO_WEEKS,
    functionName: props.functionName,
    entry: props.entry,
    handler: "handler",
    runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
    architecture: cdk.aws_lambda.Architecture.ARM_64,
    memorySize: props.memory,
    timeout: props.timeout,
    bundling: BUNDLING,
    environment: props.environment,
    ...(props.description ? { description: props.description } : {}),
  });
}
