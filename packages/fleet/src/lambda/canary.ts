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
    // The shapes the session function actually emits (`SessionBody` in session.ts; WP8.3 fixed the
    // canary, which looked for a `state` field that never existed): {off:true},
    // {starting:true, retryAfterMs}, or {endpoint, token, ...}.
    if (parsed.off === true) return "off";
    if (parsed.starting === true) return "starting";
    if (typeof parsed.endpoint === "string" && typeof parsed.token === "string") return "live";
    return "bad";
  } catch {
    return "bad";
  }
}

export const handler = async (): Promise<Record<string, number>> => {
  const page = await check(`${webOrigin.replace(/\/$/, "")}/config.json`);
  // The probe form never heals (WP8.3): a monitor must not keep an idle machine booting.
  const session = await check(`${sessionUrl}${sessionUrl.includes("?") ? "&" : "?"}probe=1`);
  const kind = session.ok ? classifySession(session.body) : "bad";
  const metrics = {
    PageOk: page.ok ? 1 : 0,
    SessionOk: kind === "bad" ? 0 : 1,
    Starting: kind === "starting" ? 1 : 0,
    Off: kind === "off" ? 1 : 0,
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
