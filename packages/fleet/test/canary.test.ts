import { describe, expect, test } from "bun:test";
import { type CanaryFetch, classifySession, probe } from "../src/canary.ts";
import type { SessionBody } from "../src/session.ts";

const body = (b: SessionBody) => JSON.stringify(b);
const live = body({
  endpoint: "x",
  token: "t",
  expiresAt: "2026-09-04T00:00:00Z",
  storeBase: "s",
  generation: 3,
});

describe("classifySession", () => {
  test("classifies the three bodies the session function emits", () => {
    expect(classifySession(body({ off: true }))).toBe("off");
    expect(classifySession(body({ starting: true, retryAfterMs: 2_000 }))).toBe("starting");
    expect(classifySession(live)).toBe("live");
  });
  test("anything else is bad", () => {
    expect(classifySession("{}")).toBe("bad");
    expect(classifySession("<html>")).toBe("bad");
    expect(classifySession(JSON.stringify({ state: "off" }))).toBe("bad");
  });
});

describe("probe", () => {
  const config = { webOrigin: "https://page.example/", sessionUrl: "https://session.example/" };

  /** Answers by URL; a missing entry is an unreachable address. */
  function answering(answers: Record<string, { ok: boolean; body: string }>) {
    const urls: string[] = [];
    const fetchImpl: CanaryFetch = async (url) => {
      urls.push(url);
      const a = answers[url];
      if (!a) throw new Error("unreachable");
      return { ok: a.ok, text: async () => a.body };
    };
    return { fetchImpl, urls };
  }

  test("asks for the page's config and the session's probe form, and records what it saw", async () => {
    const { fetchImpl, urls } = answering({
      "https://page.example/config.json": { ok: true, body: "{}" },
      "https://session.example/?probe=1": { ok: true, body: live },
    });
    expect(await probe(config, fetchImpl)).toEqual({
      metrics: { PageOk: 1, SessionOk: 1, Starting: 0, Off: 0 },
      session: "live",
    });
    expect(urls).toEqual(["https://page.example/config.json", "https://session.example/?probe=1"]);
  });

  test("starting and off are well-formed answers, counted apart", async () => {
    const starting = answering({
      "https://page.example/config.json": { ok: true, body: "{}" },
      "https://session.example/?probe=1": {
        ok: true,
        body: body({ starting: true, retryAfterMs: 5 }),
      },
    });
    expect((await probe(config, starting.fetchImpl)).metrics).toEqual({
      PageOk: 1,
      SessionOk: 1,
      Starting: 1,
      Off: 0,
    });
    const off = answering({
      "https://session.example/?probe=1": { ok: true, body: body({ off: true }) },
    });
    expect(await probe(config, off.fetchImpl)).toEqual({
      metrics: { PageOk: 0, SessionOk: 1, Starting: 0, Off: 1 },
      session: "off",
    });
  });

  test("an unreachable or failing session function is bad", async () => {
    expect((await probe(config, answering({}).fetchImpl)).session).toBe("bad");
    const failing = answering({ "https://session.example/?probe=1": { ok: false, body: live } });
    expect((await probe(config, failing.fetchImpl)).metrics.SessionOk).toBe(0);
  });

  test("a session URL that already has a query gets the probe flag appended", async () => {
    const { fetchImpl, urls } = answering({});
    await probe({ ...config, sessionUrl: "https://session.example/?v=2" }, fetchImpl);
    expect(urls[1]).toBe("https://session.example/?v=2&probe=1");
  });
});
