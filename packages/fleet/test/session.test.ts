import { beforeEach, describe, expect, test } from "bun:test";
import type { SessionConfig } from "../src/config.ts";
import { createSessionHandler, type FunctionUrlEvent, type SessionBody } from "../src/session.ts";
import {
  FakeClock,
  FakeInvoker,
  FakeLogger,
  FakeMicrovmClient,
  pointerStoreWith,
} from "../src/testing/fake.ts";

const config: SessionConfig = {
  pointerParam: "/tabframe/pointer",
  storeBase: "https://d123.cloudfront.net",
  webOrigin: "https://d123.cloudfront.net",
  rotateFunctionName: "tabframe-rotate",
  retryAfterMs: 5000,
  healCooldownMs: 10_000,
};

function event(method = "GET"): FunctionUrlEvent {
  return { requestContext: { http: { method, path: "/session" } }, headers: {} };
}

function body(res: { body: string }): SessionBody {
  return JSON.parse(res.body) as SessionBody;
}

describe("session handler", () => {
  let microvms: FakeMicrovmClient;
  let invoker: FakeInvoker;
  let clock: FakeClock;
  let log: FakeLogger;

  beforeEach(() => {
    microvms = new FakeMicrovmClient();
    invoker = new FakeInvoker();
    clock = new FakeClock();
    log = new FakeLogger();
  });

  function handler(pointer: ReturnType<typeof pointerStoreWith>) {
    return createSessionHandler({ pointer, microvms, invoker, clock, log, config });
  }

  test("off state returns {off: true} with CORS headers and heals nothing", async () => {
    const res = await handler(pointerStoreWith({ state: "off" }))(event());
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({ off: true });
    expect(res.headers["Access-Control-Allow-Origin"]).toBe(config.webOrigin);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(invoker.calls).toHaveLength(0);
  });

  test("on with no control plane heals once per cooldown and reports starting", async () => {
    const h = handler(pointerStoreWith({ state: "on" }));
    const first = await h(event());
    expect(body(first)).toEqual({ starting: true, retryAfterMs: 5000 });
    expect(first.headers["Retry-After"]).toBe("5");
    expect(invoker.calls).toEqual([
      {
        functionName: "tabframe-rotate",
        payload: { reason: "heal", detail: "pointer has no control plane" },
        mode: "async",
      },
    ]);

    await h(event());
    expect(invoker.calls).toHaveLength(1); // within the cooldown

    clock.advance(10_000);
    await h(event());
    expect(invoker.calls).toHaveLength(2);
  });

  test("running control plane: one shared token, cached, re-minted after 25 minutes", async () => {
    microvms.add({ microvmId: "mvm-1", endpoint: "mvm-1.lambda-microvm.us-west-2.on.aws" });
    const h = handler(pointerStoreWith({ state: "on", microvmId: "mvm-1", generation: 3 }));

    const a = body(await h(event()));
    if (!("token" in a)) throw new Error("expected a session");
    expect(a.endpoint).toBe("mvm-1.lambda-microvm.us-west-2.on.aws");
    expect(a.storeBase).toBe(config.storeBase);
    expect(a.generation).toBe(3);
    expect(a.expiresAt).toBe(new Date(clock.now() + 30 * 60_000).toISOString());
    expect(microvms.tokenMints).toEqual([
      { microvmId: "mvm-1", expirationInMinutes: 30, ports: [{ port: 8080 }] },
    ]);

    clock.advance(24 * 60_000);
    const b = body(await h(event()));
    if (!("token" in b)) throw new Error("expected a session");
    expect(b.token).toBe(a.token);
    expect(microvms.tokenMints).toHaveLength(1);

    clock.advance(60_000 + 1);
    const c = body(await h(event()));
    if (!("token" in c)) throw new Error("expected a session");
    expect(c.token).not.toBe(a.token);
    expect(microvms.tokenMints).toHaveLength(2);
    expect(invoker.calls).toHaveLength(0);
  });

  test("a new control plane id invalidates the cached token", async () => {
    microvms.add({ microvmId: "mvm-1" });
    microvms.add({ microvmId: "mvm-2" });
    const pointer = pointerStoreWith({ state: "on", microvmId: "mvm-1", generation: 1 });
    const h = handler(pointer);
    await h(event());
    await pointer.write({ ...(await pointer.read()), microvmId: "mvm-2", generation: 2 });
    const res = body(await h(event()));
    if (!("token" in res)) throw new Error("expected a session");
    expect(res.generation).toBe(2);
    expect(microvms.tokenMints.map((m) => m.microvmId)).toEqual(["mvm-1", "mvm-2"]);
  });

  test("a suspended control plane is served (auto-resume wakes it)", async () => {
    microvms.add({ microvmId: "mvm-1", state: "SUSPENDED" });
    const res = body(await handler(pointerStoreWith({ state: "on", microvmId: "mvm-1" }))(event()));
    expect("token" in res).toBe(true);
    expect(invoker.calls).toHaveLength(0);
  });

  test("a pending control plane reports starting without healing", async () => {
    microvms.add({ microvmId: "mvm-1", state: "PENDING" });
    const res = body(await handler(pointerStoreWith({ state: "on", microvmId: "mvm-1" }))(event()));
    expect(res).toEqual({ starting: true, retryAfterMs: 5000 });
    expect(invoker.calls).toHaveLength(0);
  });

  test("a terminated or missing control plane heals", async () => {
    microvms.add({ microvmId: "mvm-1", state: "TERMINATED" });
    const gone = body(
      await handler(pointerStoreWith({ state: "on", microvmId: "mvm-1" }))(event()),
    );
    expect(gone).toEqual({ starting: true, retryAfterMs: 5000 });
    expect(invoker.calls).toHaveLength(1);

    const missing = body(
      await handler(pointerStoreWith({ state: "on", microvmId: "mvm-404" }))(event()),
    );
    expect(missing).toEqual({ starting: true, retryAfterMs: 5000 });
    expect(invoker.calls).toHaveLength(2);
  });

  test("falls back to the pointer's endpoint when the API returns none", async () => {
    microvms.add({ microvmId: "mvm-1", endpoint: null });
    const res = body(
      await handler(
        pointerStoreWith({ state: "on", microvmId: "mvm-1", endpoint: "from-pointer.on.aws" }),
      )(event()),
    );
    if (!("token" in res)) throw new Error("expected a session");
    expect(res.endpoint).toBe("from-pointer.on.aws");
  });

  test("OPTIONS is a CORS preflight, other methods are rejected", async () => {
    const h = handler(pointerStoreWith({ state: "off" }));
    const opt = await h(event("OPTIONS"));
    expect(opt.statusCode).toBe(204);
    expect(opt.headers["Access-Control-Allow-Methods"]).toBe("GET, OPTIONS");
    const post = await h(event("POST"));
    expect(post.statusCode).toBe(405);
  });
});
