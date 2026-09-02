// Shared wiring for the operator scripts (run by `mise run rotate|up|down` after the whoami guard).
import { EventBridgeRuleControl, LambdaInvoker, SsmPointerStore } from "../src/aws.ts";
import { loadOpsConfig } from "../src/config.ts";
import { SdkMicrovmClient } from "../src/microvm-client.ts";
import type { OpsDeps } from "../src/ops.ts";
import { consoleLogger, realSleeper } from "../src/types.ts";

export function operatorDeps(): OpsDeps {
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
