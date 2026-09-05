// Wiring for the operator scripts: real clients under the Tabframe identity, and what the deployed
// stacks say about themselves. Importing this module refuses any other identity, so a script run
// by hand cannot fall back to a default profile.
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  EventBridgeRuleControl,
  LambdaInvoker,
  SecretsManagerReader,
  SsmPointerStore,
} from "./aws.ts";
import { loadOpsConfig, type OpsConfig } from "./config.ts";
import { assertTabframeIdentity } from "./identity.ts";
import { SdkMicrovmClient } from "./microvm-client.ts";
import { NAMES } from "./names.ts";
import type { OpsDeps } from "./ops.ts";
import type { PointerStore } from "./pointer.ts";
import {
  consoleLogger,
  type Invoker,
  type MicrovmClient,
  type RuleControl,
  realSleeper,
  type SecretReader,
} from "./types.ts";

assertTabframeIdentity(process.env);

const cfn = new CloudFormationClient({});

/** A deployed stack's outputs by key. */
export async function stackOutputs(stackName: string): Promise<Record<string, string>> {
  const r = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  return Object.fromEntries(
    (r.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey ?? "", o.OutputValue ?? ""]),
  );
}

/** The image ARN embeds the account id, so it is never in the repo: the environment or the deployed stack names it. */
export async function resolveImageArn(): Promise<string> {
  if (process.env.TABFRAME_IMAGE_ARN) return process.env.TABFRAME_IMAGE_ARN;
  const arn = (await stackOutputs("TabframeImage")).ImageArn;
  if (!arn) throw new Error("TabframeImage stack has no ImageArn output; deploy first");
  return arn;
}

export interface OperatorClients {
  pointer: PointerStore;
  microvms: MicrovmClient;
  invoker: Invoker;
  rules: RuleControl;
  secrets: SecretReader;
}

/** Real adapters for the deployed fleet. */
export function operatorClients(
  pointerParam: string = process.env.TABFRAME_POINTER_PARAM ?? NAMES.pointerParam,
): OperatorClients {
  return {
    pointer: new SsmPointerStore(pointerParam),
    microvms: new SdkMicrovmClient(),
    invoker: new LambdaInvoker(),
    rules: new EventBridgeRuleControl(),
    secrets: new SecretsManagerReader(),
  };
}

/** The ops configuration with the image ARN resolved; the environment is read, never written. */
export async function loadOperatorConfig(): Promise<OpsConfig> {
  return loadOpsConfig({ ...process.env, TABFRAME_IMAGE_ARN: await resolveImageArn() });
}

/** Everything `up`, `down`, `pin` and `rotateNow` need against the deployed fleet. */
export async function operatorDeps(): Promise<OpsDeps> {
  const config = await loadOperatorConfig();
  const { pointer, microvms, invoker, rules } = operatorClients(config.pointerParam);
  return { pointer, microvms, invoker, rules, sleep: realSleeper, log: consoleLogger, config };
}
