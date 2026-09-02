// Lambda entry point for the rotate function. Wires real AWS clients; all logic is in ../rotate.ts.
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerReader, SsmPointerStore } from "../aws.ts";
import { loadRotateConfig } from "../config.ts";
import { HttpControlPlaneClient } from "../cp-client.ts";
import { SdkMicrovmClient } from "../microvm-client.ts";
import { createRotateHandler } from "../rotate.ts";
import { consoleLogger, realClock, realSleeper } from "../types.ts";

const config = loadRotateConfig(process.env);
const microvms = new SdkMicrovmClient();
const snapshotBucket = process.env.TABFRAME_SNAPSHOT_BUCKET ?? "";
const s3 = new S3Client({});

/**
 * The pointer the control plane keeps fresh (design §9.4). A successor is told about it at boot so
 * it is useful even if the handover never happens.
 */
async function latestSnapshotKey(): Promise<string | null> {
  if (!snapshotBucket) return null;
  try {
    const out = await s3.send(
      new ListObjectsV2Command({ Bucket: snapshotBucket, Prefix: "latest.json.gz", MaxKeys: 1 }),
    );
    return out.Contents?.[0]?.Key ?? null;
  } catch (error) {
    consoleLogger.warn("rotate: could not read the latest snapshot key", { reason: String(error) });
    return null;
  }
}

export const handler = createRotateHandler({
  pointer: new SsmPointerStore(config.pointerParam),
  microvms,
  secrets: new SecretsManagerReader(),
  clock: realClock,
  sleep: realSleeper,
  log: consoleLogger,
  config,
  controlPlane: (secret) => new HttpControlPlaneClient({ microvms, secret }),
  latestSnapshotKey,
});
