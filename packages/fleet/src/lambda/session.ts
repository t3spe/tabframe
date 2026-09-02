// Lambda entry point for the session function. Wires real AWS clients; all logic is in ../session.ts.
import { LambdaInvoker, SsmPointerStore } from "../aws.ts";
import { loadSessionConfig } from "../config.ts";
import { SdkMicrovmClient } from "../microvm-client.ts";
import { createSessionHandler } from "../session.ts";
import { consoleLogger, realClock } from "../types.ts";

const config = loadSessionConfig(process.env);

export const handler = createSessionHandler({
  pointer: new SsmPointerStore(config.pointerParam),
  microvms: new SdkMicrovmClient(),
  invoker: new LambdaInvoker(),
  clock: realClock,
  log: consoleLogger,
  config,
});
