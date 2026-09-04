// The page's configuration (WP8.3): `/config.json` names the session URL. One failed fetch used to
// leave the dashboard on "Connecting… the page keeps trying on its own" for ever, which was false.
// This keeps trying, with a backoff that tops out at thirty seconds, and says what it is doing.

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

export interface ConfigLoadDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Told about each failure and the wait before the next try. */
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

/** Resolve the session URL from `/config.json`, retrying until it answers. */
export async function loadSessionUrl(origin: string, deps: ConfigLoadDeps = {}): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetchImpl("/config.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`config.json answered ${res.status}`);
      const config = (await res.json()) as { sessionUrl?: unknown };
      if (typeof config.sessionUrl !== "string" || config.sessionUrl.length === 0)
        throw new Error("config.json names no session URL");
      return new URL(config.sessionUrl, origin).toString();
    } catch (err) {
      const delay = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** (attempt - 1));
      deps.onRetry?.(attempt, delay, err instanceof Error ? err.message : String(err));
      await sleep(delay);
    }
  }
}
