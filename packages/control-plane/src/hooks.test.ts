import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  HOOK_PREFIX,
  type HookHost,
  handleHook,
  hookName,
  parseRunBody,
  type RunPayload,
} from "./hooks.ts";

// handleHook in-process behind a tiny http server, so every branch is measured here; the
// process-level test covers the same routes through the real private listener.
const calls: string[] = [];
let runPayload: RunPayload | null = null;
let listening = true;
let validateOk = true;
const host: HookHost = {
  isListening: () => listening,
  onValidate: () => validateOk,
  async onRun(payload) {
    runPayload = payload;
    calls.push("run");
    return payload.role === "control-plane"
      ? { ok: true, role: "control-plane" }
      : { ok: false, reason: "a core needs a session URL" };
  },
  async onSuspend() {
    calls.push("suspend");
  },
  async onResume() {
    calls.push("resume");
  },
  async onTerminate() {
    calls.push("terminate");
  },
};

let server: Server;
let base = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    void handleHook(host, hookName(url.pathname) ?? "", req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (addr && typeof addr !== "string") base = `http://127.0.0.1:${addr.port}${HOOK_PREFIX}`;
});
afterAll(() => server.close());

const post = (name: string, body?: unknown) =>
  fetch(
    `${base}${name}`,
    body === undefined ? { method: "POST" } : { method: "POST", body: JSON.stringify(body) },
  );

describe("handleHook", () => {
  test("ready reflects the listening state", async () => {
    expect((await post("ready")).status).toBe(200);
    listening = false;
    expect((await post("ready")).status).toBe(503);
    listening = true;
  });
  test("validate reflects the self-test", async () => {
    expect((await post("validate")).status).toBe(200);
    validateOk = false;
    expect((await post("validate")).status).toBe(503);
    validateOk = true;
  });
  test("run parses the payload and reports the host's verdict, with the reason on a refusal", async () => {
    const ok = await post("run", {
      microvmId: "mvm-1",
      runHookPayload: JSON.stringify({ role: "control-plane", generation: 4, fleetSecret: "s" }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ role: "control-plane", ok: true });
    expect(runPayload?.generation).toBe(4);
    expect(runPayload?.fleetSecret).toBe("s");
    const refused = await post("run", { runHookPayload: { role: "core", generation: 5 } });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      role: "core",
      ok: false,
      reason: "a core needs a session URL",
    });
    expect((await post("run", "garbage")).status).toBe(400);
    expect((await post("run")).status).toBe(400);
  });
  test("resume, suspend, terminate call through; unknown is 404; GET is 405", async () => {
    for (const name of ["resume", "suspend", "terminate"])
      expect((await post(name)).status).toBe(200);
    expect(calls).toEqual(expect.arrayContaining(["run", "resume", "suspend", "terminate"]));
    expect((await post("nope")).status).toBe(404);
    expect((await fetch(`${base}ready`)).status).toBe(405);
  });
  test("oversized run bodies are refused", async () => {
    const big = { runHookPayload: "x".repeat(70 * 1024) };
    expect((await post("run", big)).status).toBe(400);
  });
});

describe("hookName", () => {
  test("names the hook under the prefix and nothing else", () => {
    expect(hookName(`${HOOK_PREFIX}run`)).toBe("run");
    expect(hookName(`${HOOK_PREFIX}`)).toBe("");
    expect(hookName("/health")).toBeNull();
    expect(hookName("/aws/lambda-microvms/runtime/v2/run")).toBeNull();
  });
});

describe("parseRunBody", () => {
  test("accepts a stringified or object payload and rejects junk", () => {
    const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    const a = parseRunBody(
      enc({
        microvmId: "m",
        runHookPayload: JSON.stringify({
          role: "control-plane",
          generation: 3,
          storeBase: "https://s/blob",
        }),
      }),
    );
    expect(a?.payload.role).toBe("control-plane");
    expect(a?.payload.generation).toBe(3);
    expect(a?.payload.storeBase).toBe("https://s/blob");
    expect(a?.payload.snapshotKey).toBeNull();
    const b = parseRunBody(enc({ runHookPayload: { role: "core", generation: 0 } }));
    expect(b?.payload.role).toBe("core");
    expect(b?.microvmId).toBeNull();
    expect(parseRunBody(null)).toBeNull();
    expect(parseRunBody(new TextEncoder().encode("{"))).toBeNull();
    expect(parseRunBody(enc({ runHookPayload: "{" }))).toBeNull();
    expect(parseRunBody(enc({ runHookPayload: { role: "root", generation: 1 } }))).toBeNull();
    expect(parseRunBody(enc({ runHookPayload: { role: "core", generation: -1 } }))).toBeNull();
    expect(parseRunBody(enc([1]))).toBeNull();
  });
});
