import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { CLOSE, LIMITS, PROTOCOL_VERSION } from "@tabframe/protocol";
import { parseRunBody } from "./hooks.ts";
import { selfTest } from "./server.ts";
import { LocalStore, parseRange } from "./store/local.ts";

// The process under test runs under Node, the production runtime, not under Bun.
const MAIN = path.resolve(import.meta.dir, "main.ts");
let child: ChildProcess;
let pub = "";
let priv = "";
const env = { v: PROTOCOL_VERSION, gen: 1 };

function startProcess(): Promise<void> {
  return new Promise((resolve, reject) => {
    child = spawn("node", [MAIN], {
      env: {
        ...process.env,
        TABFRAME_MODE: "local",
        TABFRAME_PUBLIC_PORT: "0",
        TABFRAME_PRIVATE_PORT: "0",
        TABFRAME_TICK_MS: "50",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      for (const line of buf.split("\n")) {
        if (!line.includes('"listening"')) continue;
        const info = JSON.parse(line) as { publicPort: number; privatePort: number; host: string };
        pub = `http://${info.host}:${info.publicPort}`;
        priv = `http://${info.host}:${info.privatePort}`;
        resolve();
      }
    });
    child.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
    child.on("exit", (code) => {
      if (!pub) reject(new Error(`process exited early with ${code}`));
    });
    setTimeout(() => reject(new Error("process did not start")), 15_000);
  });
}

function open(pathname: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${pub.replace("http", "ws")}${pathname}`);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e);
  });
}

function next(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.onmessage = (e) => resolve(JSON.parse(String(e.data)) as Record<string, unknown>);
  });
}

function closed(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
  });
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

beforeAll(async () => {
  await startProcess();
});
afterAll(async () => {
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
});

describe("process", () => {
  test("health and session on the two ports", async () => {
    const health = (await (await fetch(`${priv}/health`)).json()) as Record<string, unknown>;
    expect(health.ok).toBe(true);
    expect(health.role).toBe("control-plane");
    expect(health.protocol).toBe(PROTOCOL_VERSION);
    const session = (await (await fetch(`${pub}/session`)).json()) as Record<string, unknown>;
    expect(String(session.endpoint)).toStartWith("ws://");
    expect(String(session.storeBase)).toBe(`${pub}/blob`);
    expect(session.generation).toBe(1);
    const cfg = (await (await fetch(`${pub}/config.json`)).json()) as Record<string, unknown>;
    expect(cfg.sessionUrl).toBe("/session");
    expect((await fetch(`${pub}/health`)).status).toBe(404); // private routes are not on the public port
  });

  test("hello → welcome, observer sees the node in a snapshot and later nodes joining", async () => {
    const observer = await open("/observer");
    const snapP = next(observer);
    observer.send(JSON.stringify({ t: "subscribe", ...env }));
    const snap = await snapP;
    expect(snap.t).toBe("snapshot");
    expect((snap.nodes as unknown[]).length).toBe(0);

    const node = await open("/node");
    const joinedP = next(observer);
    const welcomeP = next(node);
    node.send(
      JSON.stringify({
        t: "hello",
        ...env,
        hostId: "h1",
        kind: "tab",
        cores: 4,
        sandboxVersion: "1",
      }),
    );
    const welcome = await welcomeP;
    expect(welcome.t).toBe("welcome");
    expect(welcome.nodeId).toBe("n1");
    expect(welcome.heartbeatMs).toBe(LIMITS.heartbeatMs);
    const joined = await joinedP;
    expect(joined.t).toBe("nodeJoined");
    expect((joined.node as Record<string, unknown>).nodeId).toBe("n1");

    const pongP = next(observer);
    observer.send(JSON.stringify({ t: "ping", ...env }));
    expect((await pongP).t).toBe("pong");

    const leftP = next(observer);
    node.close();
    const left = await leftP;
    expect(left.t).toBe("nodeLeft");
    expect(left.reason).toBe("closed");
    observer.close();
  });

  test("a node that stops heartbeating is declared gone by silence", async () => {
    const observer = await open("/observer");
    const snapP = next(observer);
    observer.send(JSON.stringify({ t: "subscribe", ...env }));
    await snapP;
    const node = await open("/node");
    const welcomeP = next(node);
    const joinedP = next(observer);
    node.send(
      JSON.stringify({
        t: "hello",
        ...env,
        hostId: "h2",
        kind: "core",
        cores: 1,
        sandboxVersion: "1",
      }),
    );
    await welcomeP;
    expect((await joinedP).t).toBe("nodeJoined");
    const closedP = closed(node);
    const leftP = next(observer);
    const gone = await closedP;
    expect(gone.code).toBe(CLOSE.declaredGone);
    const left = await leftP;
    expect(left.t).toBe("nodeLeft");
    expect(left.reason).toBe("silent");
    observer.close();
  }, 10_000);

  test("invalid messages close the socket with the protocol's code", async () => {
    const node = await open("/node");
    const closedP = closed(node);
    node.send("{not json");
    expect((await closedP).code).toBe(CLOSE.invalidMessage);
    const other = await open("/node");
    const closedQ = closed(other);
    other.send(
      JSON.stringify({
        t: "hello",
        v: PROTOCOL_VERSION,
        gen: 99,
        hostId: "h",
        kind: "tab",
        cores: 1,
        sandboxVersion: "1",
      }),
    );
    expect((await closedQ).code).toBe(CLOSE.generationMismatch);
  });

  test("unknown socket paths are refused", async () => {
    await expect(open("/elsewhere")).rejects.toBeDefined();
  });

  test("local store: hash-verified PUT, GET, HEAD, Range, 404", async () => {
    const bytes = new TextEncoder().encode("hello tabframe store");
    const hash = sha(bytes);
    const bad = await fetch(`${pub}/blob/${hash}`, {
      method: "PUT",
      body: new Uint8Array([1, 2, 3]),
    });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${pub}/blob/${hash}`, { method: "PUT", body: bytes });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { size: number }).size).toBe(bytes.length);
    const got = await fetch(`${pub}/blob/${hash}`);
    expect(got.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
    const head = await fetch(`${pub}/blob/${hash}`, { method: "HEAD" });
    expect(head.headers.get("content-length")).toBe(String(bytes.length));
    const part = await fetch(`${pub}/blob/${hash}`, { headers: { range: "bytes=6-13" } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe("tabframe");
    expect((await fetch(`${pub}/blob/${"0".repeat(64)}`)).status).toBe(404);
    expect((await fetch(`${pub}/blob/not-a-hash`)).status).toBe(400);
  });

  test("lifecycle hooks answer on the private port", async () => {
    const hook = (name: string, body?: unknown) =>
      fetch(
        `${priv}/aws/lambda-microvms/runtime/v1/${name}`,
        body === undefined ? { method: "POST" } : { method: "POST", body: JSON.stringify(body) },
      );
    expect((await hook("ready")).status).toBe(200);
    expect((await hook("validate")).status).toBe(200);
    for (const name of ["resume", "suspend", "terminate"])
      expect((await hook(name)).status).toBe(200);
    // Local mode is already a control plane, so a second role assignment is refused.
    const run = await hook("run", {
      microvmId: "mvm-1",
      runHookPayload: JSON.stringify({ role: "core", generation: 2 }),
    });
    expect(run.status).toBe(400);
    expect((await hook("bogus")).status).toBe(404);
    expect((await fetch(`${priv}/aws/lambda-microvms/runtime/v1/ready`)).status).toBe(405);
    expect((await fetch(`${priv}/diag`)).status).toBe(200);
  });

  test("static fallback page is served when no web bundle exists", async () => {
    const res = await fetch(`${pub}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("web bundle is not built");
    expect((await fetch(`${pub}/nope.js`)).status).toBe(404);
  });
});

describe("pure helpers", () => {
  test("selfTest passes against a scratch ledger", () => {
    expect(selfTest()).toBe(true);
  });

  test("parseRunBody accepts a stringified or object payload and rejects junk", () => {
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

  test("LocalStore hashes on put, verifies on putVerified, and builds URLs", async () => {
    const store = new LocalStore("http://x/blob");
    const bytes = new TextEncoder().encode("abc");
    const hash = await store.put(bytes);
    expect(hash).toBe(sha(bytes));
    expect(store.has(hash)).toBe(true);
    expect(store.get(hash)).toEqual(bytes);
    expect(store.url(hash)).toBe(`http://x/blob/${hash}`);
    expect(store.size).toBe(1);
    expect(await store.put(bytes)).toBe(hash);
    expect(store.size).toBe(1);
    const wrong = store.putVerified("0".repeat(64), bytes);
    expect(wrong.ok).toBe(false);
    const right = store.putVerified(sha(new Uint8Array([9])), new Uint8Array([9]));
    expect(right).toEqual({ ok: true, size: 1 });
    expect(store.get("f".repeat(64))).toBeUndefined();
  });

  test("parseRange", () => {
    expect(parseRange(undefined, 10)).toBeUndefined();
    expect(parseRange("bytes=0-3", 10)).toEqual({ start: 0, end: 3 });
    expect(parseRange("bytes=5-", 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=2-100", 10)).toEqual({ start: 2, end: 9 });
    expect(parseRange("bytes=12-", 10)).toBeNull();
    expect(parseRange("bytes=-", 10)).toBeNull();
    expect(parseRange("items=1-2", 10)).toBeNull();
  });
});
