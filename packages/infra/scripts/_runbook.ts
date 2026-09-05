// What every verification runbook shares: the pass/fail ledger and its summary, argument parsing,
// waiting for the machine, the observer socket, and browser tabs lending CPU. The checks themselves
// stay in each runbook, where tsc is their only net.
import type { Browser, Page } from "@playwright/test";
import { PROTOCOL_VERSION } from "@tabframe/protocol";
import { maskSecrets } from "../../fleet/src/mask.ts";
import { fetchSession, type Session, socketProtocols } from "../../node/src/session.ts";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `--name N` from argv, or `fallback` when absent or not a number. */
export function argNumber(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  const v = i > 0 ? Number(process.argv[i + 1]) : Number.NaN;
  return Number.isFinite(v) ? v : fallback;
}

export const results: Array<{ check: string; result: string; pass: boolean | null }> = [];

/** One line per check, masked; a null `pass` is informational. */
export function record(check: string, result: string, pass: boolean | null = null): void {
  results.push({ check, result, pass });
  console.log(`${pass === null ? "·" : pass ? "✓" : "✗"} ${check}: ${maskSecrets(result)}`);
}

/** The closing count and the exit code: 1 when any check failed. */
export function summary(t0: number): never {
  const passed = results.filter((r) => r.pass === true).length;
  const failed = results.filter((r) => r.pass === false).length;
  console.log(
    `\n${passed} passed, ${failed} failed, ${results.length - passed - failed} informational; ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
  process.exit(failed ? 1 : 0);
}

export type OnSession = Session & { kind: "on" };

/** Polls the session until the machine is on; throws when it is off or never comes up. */
export async function awaitSession(sessionUrl: string): Promise<OnSession> {
  for (let i = 0; i < 60; i++) {
    const s = await fetchSession(sessionUrl, (u) => fetch(u));
    if (s.kind === "on") return s;
    if (s.kind === "off") throw new Error("the machine is off; run `mise run up`");
    await sleep(s.retryAfterMs);
  }
  throw new Error("no control plane came up");
}

export type Ev = { t: string; [k: string]: unknown };

export interface Observer {
  /** Every event received, in order. */
  events: Ev[];
  /** Sends a message stamped with the protocol version and the session's generation. */
  send(msg: Record<string, unknown>): void;
  /** The first event, past or future, that satisfies `pred`; rejects after `ms`. */
  waitFor(pred: (e: Ev) => boolean, ms: number, what: string): Promise<Ev>;
  close(): void;
}

/** An observer socket through the proxy, subscribed and kept alive with pings. */
export async function observe(session: OnSession): Promise<Observer> {
  const events: Ev[] = [];
  const waiters: Array<{ pred: (e: Ev) => boolean; resolve: (e: Ev) => void }> = [];
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`${session.endpoint}/observer`, socketProtocols(session.token));
    s.onopen = () => {
      s.send(JSON.stringify({ t: "subscribe", v: PROTOCOL_VERSION, gen: session.generation }));
      resolve(s);
    };
    s.onerror = () => reject(new Error("observer socket failed"));
    s.onmessage = (m) => {
      const ev = JSON.parse(String(m.data)) as Ev;
      events.push(ev);
      for (const w of waiters.splice(0)) w.pred(ev) ? w.resolve(ev) : waiters.push(w);
    };
  });
  const ping = setInterval(() => {
    if (ws.readyState === ws.OPEN)
      ws.send(JSON.stringify({ t: "ping", v: PROTOCOL_VERSION, gen: session.generation }));
  }, 1_500);
  return {
    events,
    send: (msg) =>
      ws.send(JSON.stringify({ ...msg, v: PROTOCOL_VERSION, gen: session.generation })),
    waitFor: (pred, ms, what) =>
      new Promise<Ev>((resolve, reject) => {
        const found = events.find(pred);
        if (found) return resolve(found);
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `timed out waiting for ${what} (${events.length} events, last ${events.at(-1)?.t})`,
              ),
            ),
          ms,
        );
        waiters.push({
          pred,
          resolve: (e) => {
            clearTimeout(timer);
            resolve(e);
          },
        });
      }),
    close: () => {
      clearInterval(ping);
      ws.close();
    },
  };
}

/** Waits until `pred` holds; records `what` as timed out and returns false otherwise. */
export async function until(pred: () => boolean, ms: number, what: string): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) {
      record(what, "timed out", false);
      return false;
    }
    await sleep(500);
  }
  return true;
}

export interface LendingTabs {
  /** How long a tab may take to show the machine live. */
  liveTimeoutMs?: number;
  /** Reload once when the page is not live in time: a tab that opens mid-rotation waits for the new control plane. */
  reloadOnce?: boolean;
  /** Prefix of the reload notice. */
  label?: string;
  onPageError?: (index: number, err: Error) => void;
}

/** Opens `count` tabs on the page; each waits for "live" and spawns one extra node (two per tab). */
export async function openLendingTabs(
  browser: Browser,
  webOrigin: string,
  count: number,
  opts: LendingTabs = {},
): Promise<Page[]> {
  const pages: Page[] = [];
  for (let i = 0; i < count; i++) {
    const page = await browser.newPage();
    const onPageError = opts.onPageError;
    if (onPageError) page.on("pageerror", (err) => onPageError(i, err));
    for (let attempt = 0; ; attempt++) {
      await page.goto(webOrigin, { waitUntil: "domcontentloaded" });
      try {
        await page
          .locator("#machine")
          .filter({ hasText: /live/ })
          .waitFor({ timeout: opts.liveTimeoutMs ?? 60_000 });
        break;
      } catch (err) {
        if (!opts.reloadOnce || attempt === 1) throw err;
        console.log(`  [${opts.label ?? "runbook"}] the page was not live; reloading`);
      }
    }
    await page.locator("#spawn1").click({ timeout: 30_000 });
    pages.push(page);
  }
  return pages;
}
