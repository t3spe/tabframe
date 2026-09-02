// Lambda entry point for the rotate function. Wires real AWS clients; all logic is in ../rotate.ts.
import { SecretsManagerReader, SsmPointerStore } from "../aws.ts";
import { loadRotateConfig } from "../config.ts";
import { SdkMicrovmClient } from "../microvm-client.ts";
import { createRotateHandler } from "../rotate.ts";
import { consoleLogger, realClock, realSleeper } from "../types.ts";

const config = loadRotateConfig(process.env);

export const handler = createRotateHandler({
  pointer: new SsmPointerStore(config.pointerParam),
  microvms: new SdkMicrovmClient(),
  secrets: new SecretsManagerReader(),
  clock: realClock,
  sleep: realSleeper,
  log: consoleLogger,
  config,
});
