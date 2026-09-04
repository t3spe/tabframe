// The canary (WP8.2): every five minutes, does the page answer and does the session function say
// something well-formed? It records three metrics — PageOk, SessionOk, Starting — and never touches
// the MicroVM endpoint, which would count as traffic and keep a suspended machine awake.
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";

const cloudwatch = new CloudWatchClient({});
const webOrigin = process.env.TABFRAME_WEB_ORIGIN ?? "";
const sessionUrl = process.env.TABFRAME_SESSION_URL ?? "";

async function check(url: string, ms = 5_000): Promise<{ ok: boolean; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    return { ok: res.ok, body: await res.text() };
  } catch {
    return { ok: false, body: "" };
  } finally {
    clearTimeout(timer);
  }
}

/** The session function's answer is one of three shapes; anything else is a failure. */
export function classifySession(body: string): "live" | "starting" | "off" | "bad" {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed.state === "off" || parsed.kind === "off") return "off";
    if (parsed.state === "starting" || parsed.kind === "starting") return "starting";
    if (typeof parsed.endpoint === "string" && typeof parsed.token === "string") return "live";
    return "bad";
  } catch {
    return "bad";
  }
}

export const handler = async (): Promise<Record<string, number>> => {
  const page = await check(`${webOrigin.replace(/\/$/, "")}/config.json`);
  const session = await check(sessionUrl);
  const kind = session.ok ? classifySession(session.body) : "bad";
  const metrics = {
    PageOk: page.ok ? 1 : 0,
    SessionOk: kind === "bad" ? 0 : 1,
    Starting: kind === "starting" ? 1 : 0,
  };
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
  console.log(JSON.stringify({ event: "canary", ...metrics, session: kind }));
  return metrics;
};
