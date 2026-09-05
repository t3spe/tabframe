// Lambda entry point for the rotate function. Wires real AWS clients; the logic is in ../rotate/.
import { S3SnapshotIndex, SecretsManagerReader, SsmPointerStore } from "../aws.ts";
import { loadRotateConfig } from "../config.ts";
import { HttpControlPlaneClient } from "../cp-client.ts";
import { SdkMicrovmClient } from "../microvm-client.ts";
import { createRotateHandler } from "../rotate.ts";
import { consoleLogger, realClock, realSleeper } from "../types.ts";

const config = loadRotateConfig(process.env);
const microvms = new SdkMicrovmClient();

const rotate = createRotateHandler({
  pointer: new SsmPointerStore(config.pointerParam),
  microvms,
  secrets: new SecretsManagerReader(),
  clock: realClock,
  sleep: realSleeper,
  log: consoleLogger,
  config,
  controlPlane: (secret) => new HttpControlPlaneClient({ microvms, secret }),
  ...(config.snapshotBucket ? { snapshots: new S3SnapshotIndex(config.snapshotBucket) } : {}),
});

/**
 * A rotation that failed is an invocation that failed, so the function's Errors metric moves and
 * the alarm can fire. The rotation is idempotent, so the platform's retries are safe.
 */
export const handler = async (event?: unknown) => {
  const result = await rotate(event);
  if (result.action === "failed") throw new Error(`rotate failed: ${result.reason}`);
  return result;
};
