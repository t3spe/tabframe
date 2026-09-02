import { describe, expect, test } from "bun:test";
import { CLOSE, LIMITS, PROTOCOL_VERSION } from "@tabframe/protocol";
import { Backoff } from "./backoff.ts";
import {
  Orchestrator,
  parseRotating,
  type SocketLike,
  type Status,
  type Timers,
} from "./orchestrator.ts";
import { fetchSession, socketProtocols } from "./session.ts";

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
    onStatus: (s) => statuses.push(s),
  });
  return {
    o,
    timers,
    sockets,
    statuses,
    fetches,
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

  test("an off session reports off and stops; a starting session retries after the hint", async () => {
    const off = harness({ off: true });
    await off.o.start();
    expect(off.statuses.at(-1)?.state).toBe("off");
    expect(off.sockets.length).toBe(0);
    expect(off.timers.pending).toBe(0);

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
