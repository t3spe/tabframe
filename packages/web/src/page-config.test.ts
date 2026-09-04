import { expect, test } from "bun:test";
import { loadSessionUrl } from "./page-config.ts";

test("a failed configuration fetch is retried with a growing wait, and the URL is resolved against the origin", async () => {
  let calls = 0;
  const waits: number[] = [];
  const retries: string[] = [];
  const url = await loadSessionUrl("https://page.example", {
    fetchImpl: (async () => {
      calls++;
      if (calls === 1) throw new TypeError("network down");
      if (calls === 2) return new Response("nope", { status: 503 });
      return new Response(JSON.stringify({ sessionUrl: "/session" }), { status: 200 });
    }) as unknown as typeof fetch,
    sleep: async (ms) => {
      waits.push(ms);
    },
    onRetry: (_attempt, _delay, reason) => retries.push(reason),
  });
  expect(url).toBe("https://page.example/session");
  expect(waits).toEqual([1_000, 2_000]);
  expect(retries).toEqual(["network down", "config.json answered 503"]);
});
