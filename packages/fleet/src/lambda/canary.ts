// Lambda entry point for the canary. Wires the real CloudWatch client; the checks are in ../canary.ts.
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { type CanaryMetrics, probe } from "../canary.ts";
import { loadCanaryConfig } from "../config.ts";

const config = loadCanaryConfig(process.env);
const cloudwatch = new CloudWatchClient({});

export const handler = async (): Promise<CanaryMetrics> => {
  const { metrics, session } = await probe(config);
  await cloudwatch.send(
    new PutMetricDataCommand({
      Namespace: "Tabframe/Canary",
      MetricData: Object.entries(metrics).map(([MetricName, Value]) => ({
        MetricName,
        Value,
        Unit: "Count",
      })),
    }),
  );
  console.log(JSON.stringify({ event: "canary", ...metrics, session }));
  return metrics;
};
