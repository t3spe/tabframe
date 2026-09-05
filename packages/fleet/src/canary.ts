// The canary: does the page answer, and does the session function say something well-formed? It
// never touches the MicroVM endpoint — that would count as traffic and keep a suspended machine
// awake — and it asks the session function's probe form, which never heals, so a monitor cannot
// keep an idle machine booting.
import type { CanaryConfig } from "./config.ts";

export type SessionKind = "live" | "starting" | "off" | "bad";

/** The session function's answer is one of three shapes (`SessionBody`); anything else is a failure. */
export function classifySession(body: string): SessionKind {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed.off === true) return "off";
    if (parsed.starting === true) return "starting";
    if (typeof parsed.endpoint === "string" && typeof parsed.token === "string") return "live";
    return "bad";
  } catch {
    return "bad";
  }
}

/** What the canary records, in the order the metrics are published. */
export interface CanaryMetrics {
  PageOk: number;
  SessionOk: number;
  Starting: number;
  Off: number;
}

export type CanaryFetch = (
  url: string,
  init: { signal: AbortSignal; cache: "no-store" },
) => Promise<{ ok: boolean; text(): Promise<string> }>;

async function check(
  fetchImpl: CanaryFetch,
  url: string,
  ms = 5_000,
): Promise<{ ok: boolean; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, cache: "no-store" });
    return { ok: res.ok, body: await res.text() };
  } catch {
    return { ok: false, body: "" };
  } finally {
    clearTimeout(timer);
  }
}

/** One round: the page's config.json and the session function's probe form. */
export async function probe(
  config: CanaryConfig,
  fetchImpl: CanaryFetch = globalThis.fetch,
): Promise<{ metrics: CanaryMetrics; session: SessionKind }> {
  const page = await check(fetchImpl, `${config.webOrigin.replace(/\/$/, "")}/config.json`);
  const session = await check(
    fetchImpl,
    `${config.sessionUrl}${config.sessionUrl.includes("?") ? "&" : "?"}probe=1`,
  );
  const kind = session.ok ? classifySession(session.body) : "bad";
  return {
    metrics: {
      PageOk: page.ok ? 1 : 0,
      SessionOk: kind === "bad" ? 0 : 1,
      Starting: kind === "starting" ? 1 : 0,
      Off: kind === "off" ? 1 : 0,
    },
    session: kind,
  };
}
