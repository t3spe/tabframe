// Shared wiring for the operator scripts (run by `mise run rotate|up|down` after the whoami guard).
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { EventBridgeRuleControl, LambdaInvoker, SsmPointerStore } from "../src/aws.ts";
import { loadOpsConfig } from "../src/config.ts";
import { SdkMicrovmClient } from "../src/microvm-client.ts";
import type { OpsDeps } from "../src/ops.ts";
import { consoleLogger, realSleeper } from "../src/types.ts";

/** The image ARN embeds the account id, so it is never in the repo: read it from the deployed stack. */
async function resolveImageArn(): Promise<void> {
  if (process.env.TABFRAME_IMAGE_ARN) return;
  const cfn = new CloudFormationClient({});
  const r = await cfn.send(new DescribeStacksCommand({ StackName: "TabframeImage" }));
  const out = r.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === "ImageArn")?.OutputValue;
  if (!out) throw new Error("TabframeImage stack has no ImageArn output; deploy first");
  process.env.TABFRAME_IMAGE_ARN = out;
}

export async function operatorDeps(): Promise<OpsDeps> {
  await resolveImageArn();
  const config = loadOpsConfig(process.env);
  return {
    pointer: new SsmPointerStore(config.pointerParam),
    microvms: new SdkMicrovmClient(),
    invoker: new LambdaInvoker(),
    rules: new EventBridgeRuleControl(),
    sleep: realSleeper,
    log: consoleLogger,
    config,
  };
}

/** Never let an account id or endpoint token reach the terminal unmasked. */
export function mask(text: string): string {
  return text
    .replace(/\b(\d{8})(\d{4})\b/g, (_m, _h: string, tail: string) => `********${tail}`)
    .replace(/"token":"[^"]+"/g, '"token":"<redacted>"');
}
