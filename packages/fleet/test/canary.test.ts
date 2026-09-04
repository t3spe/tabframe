import { describe, expect, test } from "bun:test";
import { classifySession } from "../src/lambda/canary.ts";
import type { SessionBody } from "../src/session.ts";

// The canary reads the session function's real shapes (WP8.3): loop 2's canary looked for a
// `state` field that never existed, so every `down` would have paged and a stuck heal never would.
describe("canary", () => {
  const body = (b: SessionBody) => JSON.stringify(b);
  test("classifies the three bodies the session function emits", () => {
    expect(classifySession(body({ off: true }))).toBe("off");
    expect(classifySession(body({ starting: true, retryAfterMs: 2_000 }))).toBe("starting");
    expect(
      classifySession(
        body({
          endpoint: "x",
          token: "t",
          expiresAt: "2026-09-04T00:00:00Z",
          storeBase: "s",
          generation: 3,
        }),
      ),
    ).toBe("live");
  });
  test("anything else is bad", () => {
    expect(classifySession("{}")).toBe("bad");
    expect(classifySession("<html>")).toBe("bad");
    expect(classifySession(JSON.stringify({ state: "off" }))).toBe("bad");
  });
});
