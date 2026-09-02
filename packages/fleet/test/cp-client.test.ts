import { describe, expect, test } from "bun:test";
import { FLEET_TOKEN_MINUTES, HttpControlPlaneClient, PRIVATE_PORT } from "../src/cp-client.ts";
import { FakeMicrovmClient } from "../src/testing/fake.ts";

const target = { microvmId: "mvm-1", endpoint: "mvm-1.lambda-microvm.us-west-2.on.aws" };

function client(
  reply: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) => {
    ok: boolean;
    status: number;
    body: string;
  },
) {
  const microvms = new FakeMicrovmClient();
  const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
  const cp = new HttpControlPlaneClient({
    microvms,
    secret: "s3cret",
    fetchImpl: async (url, init) => {
      calls.push({ url, headers: init.headers, ...(init.body ? { body: init.body } : {}) });
      const r = reply(url, init);
      return { ok: r.ok, status: r.status, text: async () => r.body };
    },
  });
  return { cp, calls, microvms };
}

describe("HttpControlPlaneClient", () => {
  test("mints a short token scoped to the private port and sends the fleet secret", async () => {
    const { cp, calls, microvms } = client(() => ({
      ok: true,
      status: 200,
      body: '{"generation":7,"ledger":{"version":1}}',
    }));
    const r = await cp.handover(target);
    expect(r.generation).toBe(7);
    expect(r.ledger).toBe('{"version":1}');
    expect(microvms.tokenMints).toEqual([
      {
        microvmId: "mvm-1",
        expirationInMinutes: FLEET_TOKEN_MINUTES,
        ports: [{ port: PRIVATE_PORT }],
      },
    ]);
    const call = calls[0];
    expect(call?.url).toBe(`https://${target.endpoint}/handover`);
    expect(call?.headers["X-aws-proxy-port"]).toBe(String(PRIVATE_PORT));
    expect(call?.headers["X-aws-proxy-auth"]).toBe("tok-mvm-1-1");
    expect(call?.headers["x-tabframe-fleet-secret"]).toBe("s3cret");
  });

  test("adopt posts the ledger verbatim; drain posts the next generation", async () => {
    const { cp, calls } = client((url) => ({
      ok: true,
      status: 200,
      body: url.endsWith("/adopt") ? '{"adopted":true,"generation":8}' : '{"drained":12,"next":8}',
    }));
    const ledger = '{"version":1,"meta":{"generation":7}}';
    expect(await cp.adopt(target, ledger)).toEqual({ generation: 8 });
    expect(calls[0]?.body).toBe(ledger);
    expect(await cp.drain(target, 8)).toEqual({ drained: 12 });
    expect(calls[1]?.body).toBe('{"next":8}');
  });

  test("a non-2xx answer throws with the route and the status", async () => {
    const { cp } = client(() => ({ ok: false, status: 403, body: "no" }));
    await expect(cp.handover(target)).rejects.toThrow("/handover on mvm-1 answered 403");
  });

  test("a body that is not a handover is refused", async () => {
    const { cp } = client(() => ({ ok: true, status: 200, body: '{"generation":7}' }));
    await expect(cp.handover(target)).rejects.toThrow("unusable body");
  });

  test("health reports the role and generation", async () => {
    const { cp } = client(() => ({
      ok: true,
      status: 200,
      body: '{"ok":true,"role":"control-plane","generation":9}',
    }));
    expect(await cp.health(target)).toEqual({ role: "control-plane", generation: 9 });
  });
});
