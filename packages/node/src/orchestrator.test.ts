import { describe, expect, test } from "bun:test";
import {
  CLOSE,
  decodeRunInput,
  encodePlanInput,
  LIMITS,
  PROTOCOL_VERSION,
  RELEASED,
} from "@tabframe/protocol";
import type { HostRequest, TaskResult } from "@tabframe/sandbox";
import { sha256Hex } from "@tabframe/store";
import { Backoff } from "./backoff.ts";
import {
  OFF_POLL_MS,
  parseRotating,
  resolveStoreBase,
  type SocketLike,
  type Timers,
} from "./connection.ts";
import { Orchestrator, type Status } from "./orchestrator.ts";
import { fetchSession, socketProtocols } from "./session.ts";
import { THROTTLE_MIN_MS } from "./task-loop.ts";
import { GRACE_MS, type SandboxRunner } from "./tasks.ts";

/** Manually advanced timers. */
class FakeTimers implements Timers {
  now = 0;
  private handles = new Map<number, { at: number; fn: () => void }>();
  private next = 1;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.handles.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.handles.delete(handle);
  }
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.handles.entries()]
        .filter(([, h]) => h.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.now = due[1].at;
      this.handles.delete(due[0]);
      due[1].fn();
      await Promise.resolve();
    }
    this.now = target;
    await Promise.resolve();
  }
  get pending(): number {
    return this.handles.size;
  }
}

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closedWith: { code: number | undefined; reason: string | undefined } | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  url: string;
  protocols: string[] | undefined;
  constructor(url: string, protocols?: string[]) {
    this.url = url;
    this.protocols = protocols;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  deliver(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  serverClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

const GEN = 5;
const sessionOn = {
  endpoint: "ws://cp.test",
  token: "tok",
  expiresAt: 0,
  storeBase: "http://cp.test/blob",
  generation: GEN,
};

function harness(sessionBody: unknown = sessionOn) {
  const timers = new FakeTimers();
  const sockets: FakeSocket[] = [];
  const statuses: Status[] = [];
  let body: unknown = sessionBody;
  const fetches: string[] = [];
  const sandbox = new FakeSandbox();
  const server = blobServer("http://cp.test/blob");
  let now = 0;
  const o = new Orchestrator({
    sessionUrl: "http://session.test/session",
    hostId: "host-1",
    kind: "tab",
    cores: 4,
    sandboxVersion: "0",
    fetch: async (url) => {
      fetches.push(url);
      return { ok: true, status: 200, json: async () => body };
    },
    connect: (url, protocols) => {
      const s = new FakeSocket(url, protocols);
      sockets.push(s);
      return s;
    },
    timers,
    rng: () => 0.5,
    createSandbox: () => sandbox,
    blobFetch: server.fetchImpl,
    compile: async () => ({}) as WebAssembly.Module,
    now: () => now,
    onStatus: (s) => statuses.push(s),
  });
  return {
    o,
    timers,
    sockets,
    statuses,
    fetches,
    sandbox,
    server,
    tick(ms: number) {
      now += ms;
    },
    setSession(b: unknown) {
      body = b;
    },
    last: () => sockets[sockets.length - 1] as FakeSocket,
    welcome(nodeId = "n1") {
      const s = sockets[sockets.length - 1] as FakeSocket;
      s.open();
      s.deliver({
        t: "welcome",
        v: PROTOCOL_VERSION,
        gen: GEN,
        nodeId,
        heartbeatMs: LIMITS.heartbeatMs,
        maxInFlight: 2,
        storeBase: "http://cp.test/blob",
      });
    },
  };
}

const parseSent = (s: FakeSocket) => s.sent.map((x) => JSON.parse(x) as Record<string, unknown>);

/** A sandbox the test settles by hand: every run is recorded and resolved through `finish`. */
class FakeSandbox implements SandboxRunner {
  runs: Array<{ request: HostRequest; deadlineMs: number; settle: (r: TaskResult) => void }> = [];
  disposed = 0;
  run(_module: WebAssembly.Module, request: HostRequest, deadlineMs: number): Promise<TaskResult> {
    return new Promise((settle) => {
      this.runs.push({ request, deadlineMs, settle });
    });
  }
  dispose(): void {
    this.disposed += 1;
    for (const r of this.runs.splice(0)) r.settle({ ok: false, error: "disposed", log: "" });
  }
  finish(result: TaskResult): void {
    const r = this.runs.shift();
    if (!r) throw new Error("no run to finish");
    r.settle(result);
  }
}

/** An in-memory blob server behind fetch: GET by hash, PUT by hash. */
function blobServer(base: string) {
  const blobs = new Map<string, Uint8Array>();
  const puts: string[] = [];
  const gets: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const hash = url.slice(base.length + 1);
    if (init?.method === "PUT") {
      puts.push(hash);
      blobs.set(hash, new Uint8Array(init.body as ArrayBuffer));
      return new Response(null, { status: 200 });
    }
    gets.push(hash);
    const bytes = blobs.get(hash);
    return bytes
      ? new Response(bytes as unknown as BodyInit, { status: 200 })
      : new Response(null, { status: 404 });
  };
  return { blobs, puts, gets, fetchImpl };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("orchestrator", () => {
  test("fetches a session, connects to /node with the token subprotocols, says hello, becomes idle on welcome", async () => {
    const h = harness();
    await h.o.start();
    expect(h.fetches).toEqual(["http://session.test/session"]);
    expect(h.last().url).toBe("ws://cp.test/node");
    expect(h.last().protocols).toEqual([
      "lambda-microvms",
      "lambda-microvms.authentication.tok",
      "lambda-microvms.port.8080",
    ]);
    h.welcome("n7");
    const hello = parseSent(h.last())[0];
    expect(hello?.t).toBe("hello");
    expect(hello?.gen).toBe(GEN);
    expect(hello?.hostId).toBe("host-1");
    expect(h.o.currentNodeId).toBe("n7");
    expect(h.statuses.map((s) => s.state)).toEqual(["connecting", "idle"]);
    expect(h.statuses.at(-1)?.nodeId).toBe("n7");
  });

  test("heartbeats every interval carrying visibility and stats", async () => {
    const h = harness();
    await h.o.start();
    h.welcome();
    await h.timers.advance(LIMITS.heartbeatMs * 3);
    const beats = parseSent(h.last()).filter((m) => m.t === "heartbeat");
    expect(beats.length).toBe(3);
    expect(beats[0]?.visible).toBe(true);
    h.o.setVisible(false);
    expect(h.statuses.at(-1)?.state).toBe("throttled");
    await h.timers.advance(LIMITS.heartbeatMs);
    expect(
      parseSent(h.last())
        .filter((m) => m.t === "heartbeat")
        .at(-1)?.visible,
    ).toBe(false);
  });

  test("a server close reconnects after backoff through a fresh session, as a new node", async () => {
    const h = harness();
    await h.o.start();
    h.welcome("n1");
    h.last().serverClose(CLOSE.declaredGone, "silent");
    expect(h.o.currentNodeId).toBeNull();
    expect(h.sockets.length).toBe(1);
    await h.timers.advance(LIMITS.reconnectMinMs - 1);
    expect(h.sockets.length).toBe(1);
    await h.timers.advance(LIMITS.reconnectMaxMs);
    expect(h.sockets.length).toBe(2);
    expect(h.fetches.length).toBe(2);
    h.welcome("n2");
    expect(h.o.currentNodeId).toBe("n2");
  });

  test("a rotating close waits exactly the jittered delay the control plane chose", async () => {
    const h = harness();
    await h.o.start();
    h.welcome();
    h.last().serverClose(
      CLOSE.rotatingReconnect,
      JSON.stringify({ gen: 5, next: 6, reconnectAfterMs: 7_500 }),
    );
    await h.timers.advance(7_499);
    expect(h.sockets.length).toBe(1);
    await h.timers.advance(1);
    expect(h.sockets.length).toBe(2);
  });

  test("version mismatch stops with an outdated status and never reconnects", async () => {
    const h = harness();
    await h.o.start();
    h.last().serverClose(CLOSE.versionMismatch, "v2");
    await h.timers.advance(LIMITS.reconnectMaxMs * 2);
    expect(h.sockets.length).toBe(1);
    expect(h.statuses.at(-1)?.state).toBe("outdated");
  });

  test("an off session reports off and asks again later; a starting session retries after the hint", async () => {
    const off = harness({ off: true });
    await off.o.start();
    expect(off.statuses.at(-1)?.state).toBe("off");
    expect(off.sockets.length).toBe(0);
    // An off machine is asked again: when it comes back, the node joins without a reload.
    expect(off.timers.pending).toBe(1);
    off.setSession(sessionOn);
    await off.timers.advance(OFF_POLL_MS);
    expect(off.sockets.length).toBe(1);

    const starting = harness({ starting: true, retryAfterMs: 2_000 });
    await starting.o.start();
    expect(starting.sockets.length).toBe(0);
    starting.setSession(sessionOn);
    await starting.timers.advance(2_000);
    expect(starting.sockets.length).toBe(1);
  });

  test("a failed session fetch backs off and retries", async () => {
    const timers = new FakeTimers();
    let calls = 0;
    const sockets: FakeSocket[] = [];
    const o = new Orchestrator({
      sessionUrl: "u",
      hostId: "h",
      kind: "core",
      cores: 1,
      sandboxVersion: "0",
      fetch: async () => {
        calls++;
        if (calls === 1) return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => sessionOn };
      },
      connect: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      timers,
      rng: () => 0,
      createSandbox: () => new FakeSandbox(),
      onStatus: () => {},
    });
    await o.start();
    expect(sockets.length).toBe(0);
    await timers.advance(LIMITS.reconnectMinMs);
    expect(sockets.length).toBe(1);
  });

  test("a bad message from the control plane closes the socket with the protocol code", async () => {
    const h = harness();
    await h.o.start();
    h.last().open();
    h.last().deliver({
      t: "welcome",
      v: PROTOCOL_VERSION,
      gen: GEN + 1,
      nodeId: "n1",
      heartbeatMs: 1000,
      maxInFlight: 2,
      storeBase: "http://cp.test/blob",
    });
    expect(h.last().closedWith?.code).toBe(CLOSE.generationMismatch);
  });

  test("stop closes cleanly and cancels timers", async () => {
    const h = harness();
    await h.o.start();
    h.welcome();
    h.o.stop();
    expect(h.last().closedWith?.code).toBe(1000);
    expect(h.timers.pending).toBe(0);
    expect(h.statuses.at(-1)?.state).toBe("closed");
    h.last().serverClose(1000, "stop");
    await h.timers.advance(LIMITS.reconnectMaxMs);
    expect(h.sockets.length).toBe(1);
  });
});

describe("helpers", () => {
  test("socketProtocols: none for the local token, three for a real one", () => {
    expect(socketProtocols("local")).toBeUndefined();
    expect(socketProtocols("abc", 9000)).toEqual([
      "lambda-microvms",
      "lambda-microvms.authentication.abc",
      "lambda-microvms.port.9000",
    ]);
  });
  test("fetchSession parses on, off, starting, and rejects junk", async () => {
    const mk =
      (body: unknown, ok = true) =>
      async () => ({ ok, status: ok ? 200 : 503, json: async () => body });
    expect(await fetchSession("u", mk(sessionOn))).toMatchObject({ kind: "on", generation: GEN });
    expect(await fetchSession("u", mk({ off: true }))).toEqual({ kind: "off" });
    expect(await fetchSession("u", mk({ starting: true }))).toEqual({
      kind: "starting",
      retryAfterMs: 3_000,
    });
    await expect(fetchSession("u", mk({ endpoint: 1 }))).rejects.toThrow(/malformed/);
    await expect(fetchSession("u", mk({}, false))).rejects.toThrow(/503/);
    const noExpiry = await fetchSession("u", mk({ ...sessionOn, expiresAt: undefined }));
    expect(noExpiry.kind === "on" && noExpiry.expiresAt).toBeGreaterThan(0);
  });
  test("backoff grows to the cap with jitter and resets", () => {
    const b = new Backoff(() => 1);
    const seq = [b.next(), b.next(), b.next(), b.next()];
    expect(seq[0]).toBe(LIMITS.reconnectMinMs);
    expect(seq[1]).toBe(LIMITS.reconnectMinMs * 2);
    expect(seq[2]).toBe(LIMITS.reconnectMinMs * 4);
    for (let i = 0; i < 20; i++) b.next();
    expect(b.next()).toBe(LIMITS.reconnectMaxMs);
    b.reset();
    expect(b.next()).toBe(LIMITS.reconnectMinMs);
    const zero = new Backoff(() => 0);
    zero.next();
    expect(zero.next()).toBe(LIMITS.reconnectMinMs);
  });
  test("parseRotating", () => {
    expect(parseRotating(JSON.stringify({ gen: 1, next: 2, reconnectAfterMs: 300 }))).toEqual({
      gen: 1,
      next: 2,
      reconnectAfterMs: 300,
    });
    expect(parseRotating(JSON.stringify({ reconnectAfterMs: 5 }))).toEqual({
      gen: 0,
      next: 0,
      reconnectAfterMs: 5,
    });
    expect(parseRotating("silent")).toBeNull();
    expect(parseRotating(JSON.stringify({ reconnectAfterMs: -1 }))).toBeNull();
  });
});

const PROGRAM = "a".repeat(64);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const limits = {
  maxOutputBytes: 1 << 20,
  maxWriteBytes: 1 << 20,
  maxWriteFiles: 16,
  maxLogBytes: 1 << 16,
  memoryPagesMax: 256,
};

function assignMsg(taskId: string, extra: Record<string, unknown> = {}) {
  return {
    t: "assign",
    v: PROTOCOL_VERSION,
    gen: GEN,
    taskId,
    attempt: 1,
    executionId: "e1",
    program: PROGRAM,
    kind: "run",
    stage: 2,
    index: 7,
    count: 640,
    input: b64(new Uint8Array([1, 2, 3])),
    fsRoot: null,
    deadlineMs: 3_000,
    limits,
    ...extra,
  };
}

/** Connect, welcome, and seed the blob server with the program module. */
async function connected() {
  const h = harness();
  h.server.blobs.set(PROGRAM, new Uint8Array([0, 97, 115, 109]));
  await h.o.start();
  h.welcome();
  return h;
}

/** Let the runner reach the sandbox: module fetch and compile are promises. */
async function untilRunning(h: ReturnType<typeof harness>, runs = 1) {
  for (let i = 0; i < 20 && h.sandbox.runs.length < runs; i++) await settle();
  expect(h.sandbox.runs.length).toBe(runs);
}

describe("task loop", () => {
  test("assign → module fetched once and compiled → sandbox runs the ABI-framed input → uploads → result", async () => {
    const h = await connected();
    h.last().deliver(assignMsg("t1"));
    expect(h.statuses.at(-1)?.state).toBe("busy");
    await untilRunning(h);
    const run = h.sandbox.runs[0] as { request: HostRequest; deadlineMs: number };
    expect(run.deadlineMs).toBe(3_000 + GRACE_MS); // the control plane's deadline plus the grace
    expect(run.request.kind).toBe("run");
    expect(run.request.manifest).toEqual({ version: 1, files: {} });
    expect(run.request.limits).toEqual(limits);
    const framed = decodeRunInput(run.request.input);
    expect(framed).toEqual({
      stage: 2,
      taskIndex: 7,
      taskCount: 640,
      input: new Uint8Array([1, 2, 3]),
    });
    expect(h.server.gets).toEqual([PROGRAM]);

    h.tick(250);
    const output = new Uint8Array([9, 9, 9, 9]);
    const written = new Uint8Array([5, 5]);
    h.sandbox.finish({
      ok: true,
      output,
      writes: new Map([["/out/a", written]]),
      log: "hi",
      computeMs: 250,
    });
    await settle();
    // The presign round trip goes over the socket; the store has neither blob.
    const presign = parseSent(h.last()).find((m) => m.t === "presign") as {
      items: Array<{ hash: string; size: number }>;
      gen: number;
    };
    expect(presign.gen).toBe(GEN);
    expect(presign.items.map((i) => i.size)).toEqual([4, 2]);
    h.last().deliver({
      t: "presigned",
      v: PROTOCOL_VERSION,
      gen: GEN,
      urls: presign.items.map((i) => ({
        hash: i.hash,
        url: `http://cp.test/blob/${i.hash}`,
        headers: { "x-amz-checksum-sha256": "x" },
      })),
    });
    for (let i = 0; i < 20 && !parseSent(h.last()).some((m) => m.t === "result"); i++)
      await settle();
    const result = parseSent(h.last()).find((m) => m.t === "result") as Record<string, unknown>;
    expect(result.taskId).toBe("t1");
    expect(result.attempt).toBe(1);
    expect(result.output).toBe(await sha256Hex(output));
    expect(result.outputSize).toBe(4);
    expect(result.writes).toEqual([{ path: "/out/a", hash: await sha256Hex(written), size: 2 }]);
    expect(result.log).toEqual({ text: "hi" });
    expect(result.computeMs).toBe(250);
    expect(h.server.puts.sort()).toEqual(
      [await sha256Hex(output), await sha256Hex(written)].sort(),
    );
    expect(h.statuses.at(-1)?.state).toBe("idle");
    expect(h.statuses.at(-1)?.tasksDone).toBe(1);
    expect(h.statuses.at(-1)?.lastTaskMs).toBe(250);

    // The module is cached: a second task fetches nothing new.
    h.last().deliver(
      assignMsg("t2", {
        kind: "plan",
        input: b64(encodePlanInput({ stage: 0, params: { a: 1 }, hints: {} })),
      }),
    );
    await untilRunning(h);
    expect(h.server.gets).toEqual([PROGRAM]);
    const plan = h.sandbox.runs[0] as { request: HostRequest };
    expect(plan.request.kind).toBe("plan");
    expect(plan.request.input).toEqual(encodePlanInput({ stage: 0, params: { a: 1 }, hints: {} }));
  });

  test("blobs the store already has are not uploaded again (url null)", async () => {
    const h = await connected();
    h.last().deliver(assignMsg("t1"));
    await untilRunning(h);
    h.sandbox.finish({
      ok: true,
      output: new Uint8Array([1]),
      writes: new Map(),
      log: "",
      computeMs: 3,
    });
    await settle();
    const presign = parseSent(h.last()).find((m) => m.t === "presign") as {
      items: Array<{ hash: string }>;
    };
    h.last().deliver({
      t: "presigned",
      v: PROTOCOL_VERSION,
      gen: GEN,
      urls: presign.items.map((i) => ({ hash: i.hash, url: null, headers: {} })),
    });
    for (let i = 0; i < 20 && !parseSent(h.last()).some((m) => m.t === "result"); i++)
      await settle();
    expect(h.server.puts).toEqual([]);
    const result = parseSent(h.last()).find((m) => m.t === "result") as Record<string, unknown>;
    expect(result.log).toBeNull();
    expect(result.writes).toEqual([]);
  });

  test("the queue holds maxInFlight tasks, one running; extras are dropped; heartbeat carries the count", async () => {
    const h = await connected();
    h.last().deliver(assignMsg("t1"));
    h.last().deliver(assignMsg("t2"));
    h.last().deliver(assignMsg("t3"));
    await untilRunning(h);
    expect(h.statuses.at(-1)?.queue).toBe(2);
    await h.timers.advance(LIMITS.heartbeatMs);
    const hb = parseSent(h.last())
      .filter((m) => m.t === "heartbeat")
      .at(-1) as Record<string, unknown>;
    expect(hb.queue).toBe(2);
    h.sandbox.finish({ ok: false, error: "trap: boom", log: "partial" });
    await settle();
    await settle();
    const results = parseSent(h.last()).filter((m) => m.t === "result");
    expect(results.length).toBe(1);
    expect(results[0]?.error).toBe("trap: boom");
    expect(results[0]?.log).toEqual({ text: "partial" });
    // t2 runs next; t3 was refused.
    await untilRunning(h);
    expect(h.statuses.at(-1)?.queue).toBe(1);
  });

  test("a deadline kill is reported as released, not as a fault", async () => {
    const h = await connected();
    h.last().deliver(assignMsg("t1"));
    await untilRunning(h);
    h.sandbox.finish({ ok: false, error: "deadline", log: "" });
    await settle();
    await settle();
    const result = parseSent(h.last()).find((m) => m.t === "result") as Record<string, unknown>;
    expect(result.error).toBe(RELEASED);
  });

  test("cancel drops a queued task and kills a running one without a result", async () => {
    const h = await connected();
    h.last().deliver(assignMsg("t1"));
    h.last().deliver(assignMsg("t2"));
    await untilRunning(h);
    h.last().deliver({ t: "cancel", v: PROTOCOL_VERSION, gen: GEN, taskId: "t2" });
    expect(h.statuses.at(-1)?.queue).toBe(1);
    h.last().deliver({ t: "cancel", v: PROTOCOL_VERSION, gen: GEN, taskId: "t1" });
    expect(h.sandbox.disposed).toBe(1);
    await settle();
    await settle();
    expect(parseSent(h.last()).filter((m) => m.t === "result")).toEqual([]);
    expect(h.statuses.at(-1)?.state).toBe("idle");
    expect(h.statuses.at(-1)?.tasksDone).toBe(0);
    // The next task gets a fresh sandbox from the platform.
    h.last().deliver(assignMsg("t3"));
    await untilRunning(h);
  });

  test("freeze stops heartbeats and work but keeps the socket; resume brings both back", async () => {
    const h = await connected();
    h.last().deliver(assignMsg("t1"));
    await untilRunning(h);
    h.last().deliver({ t: "command", v: PROTOCOL_VERSION, gen: GEN, op: "freeze" });
    expect(h.statuses.at(-1)?.state).toBe("frozen");
    expect(h.sandbox.disposed).toBe(1);
    expect(h.last().closedWith).toBeNull();
    const before = h.last().sent.length;
    await h.timers.advance(LIMITS.heartbeatMs * 5);
    expect(h.last().sent.length).toBe(before); // silent
    h.last().deliver(assignMsg("t2"));
    expect(h.sandbox.runs.length).toBe(0); // ignored while frozen
    h.last().deliver({ t: "command", v: PROTOCOL_VERSION, gen: GEN, op: "resume" });
    expect(h.statuses.at(-1)?.state).toBe("idle");
    await h.timers.advance(LIMITS.heartbeatMs);
    expect(h.last().sent.length).toBe(before + 1);
  });

  test("throttle idles nine times the compute after each task; resume clears it", async () => {
    const h = await connected();
    h.last().deliver({ t: "command", v: PROTOCOL_VERSION, gen: GEN, op: "throttle" });
    expect(h.statuses.at(-1)?.state).toBe("throttled");
    h.last().deliver(assignMsg("t1"));
    h.last().deliver(assignMsg("t2"));
    await untilRunning(h);
    h.sandbox.finish({ ok: false, error: "trap", log: "" });
    await settle();
    await settle();
    expect(h.sandbox.runs.length).toBe(0); // t2 waits out the throttle floor
    await h.timers.advance(THROTTLE_MIN_MS - 1);
    expect(h.sandbox.runs.length).toBe(0);
    h.last().deliver({ t: "command", v: PROTOCOL_VERSION, gen: GEN, op: "resume" });
    await untilRunning(h);
    expect(h.statuses.at(-1)?.state).toBe("busy");
  });

  test("throttle waits computeMs × 9 exactly", async () => {
    const h = await connected();
    h.last().deliver({ t: "command", v: PROTOCOL_VERSION, gen: GEN, op: "throttle" });
    h.last().deliver(assignMsg("t1"));
    h.last().deliver(assignMsg("t2"));
    await untilRunning(h);
    h.tick(100);
    h.sandbox.finish({ ok: false, error: "trap", log: "" });
    await settle();
    await settle();
    await h.timers.advance(899);
    expect(h.sandbox.runs.length).toBe(0);
    await h.timers.advance(1);
    await untilRunning(h);
  });

  test("close ends the node for good", async () => {
    const h = await connected();
    h.last().deliver(assignMsg("t1"));
    await untilRunning(h);
    h.last().deliver({ t: "command", v: PROTOCOL_VERSION, gen: GEN, op: "close" });
    expect(h.statuses.at(-1)?.state).toBe("closed");
    expect(h.last().closedWith?.code).toBe(1000);
    expect(h.sandbox.disposed).toBe(1);
    await h.timers.advance(60_000);
    expect(h.sockets.length).toBe(1);
  });

  test("a socket that drops mid-task drops the task; the result goes nowhere", async () => {
    const h = await connected();
    h.last().deliver(assignMsg("t1"));
    await untilRunning(h);
    const first = h.last();
    first.serverClose(1006, "");
    expect(h.sandbox.disposed).toBe(1);
    await settle();
    await settle();
    expect(parseSent(first).filter((m) => m.t === "result")).toEqual([]);
    await h.timers.advance(LIMITS.reconnectMaxMs);
    expect(h.sockets.length).toBe(2);
    expect(h.statuses.at(-1)?.queue).toBe(0);
  });

  test("a stray presigned message is ignored; a socket close fails a pending upload", async () => {
    const h = await connected();
    h.last().deliver({ t: "presigned", v: PROTOCOL_VERSION, gen: GEN, urls: [] });
    h.last().deliver(assignMsg("t1"));
    await untilRunning(h);
    h.sandbox.finish({
      ok: true,
      output: new Uint8Array([1]),
      writes: new Map(),
      log: "",
      computeMs: 3,
    });
    await settle();
    expect(parseSent(h.last()).some((m) => m.t === "presign")).toBe(true);
    h.last().serverClose(1006, "");
    await settle();
    await settle();
    expect(parseSent(h.last()).filter((m) => m.t === "result")).toEqual([]);
    expect(h.statuses.at(-1)?.state).toBe("connecting");
  });

  test("a missing program fails the task with a node error", async () => {
    const h = await connected();
    h.last().deliver(assignMsg("t1", { program: "b".repeat(64) }));
    for (let i = 0; i < 20 && !parseSent(h.last()).some((m) => m.t === "result"); i++)
      await settle();
    const result = parseSent(h.last()).find((m) => m.t === "result") as Record<string, unknown>;
    expect(String(result.error)).toContain("not in the store");
  });

  test("resolveStoreBase: relative bases live on the control plane's HTTP origin", () => {
    expect(resolveStoreBase("/blob", "ws://localhost:4080")).toBe("http://localhost:4080/blob");
    expect(resolveStoreBase("/blob/", "wss://vm.example")).toBe("https://vm.example/blob");
    expect(resolveStoreBase("https://cdn.example/blob/", "wss://vm.example")).toBe(
      "https://cdn.example/blob",
    );
    expect(resolveStoreBase("/blob", "")).toBe("/blob");
  });
});
