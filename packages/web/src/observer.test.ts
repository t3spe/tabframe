import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LIMITS, PROTOCOL_VERSION } from "@tabframe/protocol";
import {
  CONTROL_HOLD_MS,
  CONTROL_SPACING_MS,
  MACHINE_FULL_RETRY_MS,
  ObserverClient,
} from "./observer.ts";

// WP4.4: a control clicked while the socket is between subscribes (a silent resubscribe after a
// gap or a refresh, a rotation) is held for the next live socket instead of being dropped.

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  readonly url: string;
  readonly protocols: string[] | undefined;
  constructor(url: string, protocols?: string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeSocket.instances.push(this);
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  deliver(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  frames(): Array<{ t: string }> {
    return this.sent.map((s) => JSON.parse(s) as { t: string });
  }
}

const env = { v: PROTOCOL_VERSION, gen: 2 };
const snapshot = (seq: number) => ({
  t: "snapshot",
  ...env,
  seq,
  page: 0,
  pages: 1,
  nodes: [],
  programs: [],
  execution: null,
  queue: [],
  machine: { awake: true, reason: null, redundancy: false, nextRotationAt: null, uptimeMs: 1 },
  tasks: [],
  at: 1,
});

const tick = () => new Promise((r) => setTimeout(r, 0));

let realWebSocket: unknown;
let realFetch: unknown;
beforeEach(() => {
  realWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  realFetch = globalThis.fetch;
  FakeSocket.instances = [];
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      endpoint: "wss://cp.example",
      token: "local",
      storeBase: "https://s/blob",
      generation: 2,
      expiresAt: Date.now() + 60_000,
    }),
  })) as unknown as typeof fetch;
});
afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  globalThis.fetch = realFetch as typeof fetch;
});

async function live(): Promise<{ client: ObserverClient; states: string[]; socket: FakeSocket }> {
  const states: string[] = [];
  const client = new ObserverClient(
    "https://session.example",
    { onState: (s) => states.push(s), onCluster: () => {}, onSession: () => {} },
    () => 0,
  );
  void client.start();
  await tick();
  await tick();
  const socket = FakeSocket.instances[0] as FakeSocket;
  socket.open();
  socket.deliver(snapshot(1));
  expect(states).toContain("live");
  return { client, states, socket };
}

describe("controls across a resubscribe", () => {
  test("a control issued during a silent resubscribe goes out on the next live socket", async () => {
    const { client, socket } = await live();
    // A sequence gap: the client resubscribes through a new socket at once, silently. Between
    // the close and the next snapshot the page still says live.
    socket.deliver({ t: "controlApplied", ...env, seq: 3, at: 2, op: "resumeAll", nodeIds: [] });
    await new Promise((r) => setTimeout(r, 5));
    await tick();
    await tick();
    expect(FakeSocket.instances.length).toBe(2);
    expect(client.connected).toBe(false);
    expect(client.send({ t: "killHalf" })).toBe(true);
    const next = FakeSocket.instances[1] as FakeSocket;
    next.open();
    next.deliver(snapshot(4));
    // Controls are spaced under the observer rate; the held one follows the subscribe.
    await new Promise((r) => setTimeout(r, CONTROL_SPACING_MS + 10));
    expect(next.frames().map((f) => f.t)).toEqual(["subscribe", "killHalf"]);
    expect(socket.frames().map((f) => f.t)).toEqual(["subscribe"]);
    client.stop();
  });

  test("a held redundancy toggle shows its value again after the snapshot that revived the socket", async () => {
    const clusters: boolean[] = [];
    const client = new ObserverClient(
      "https://session.example",
      {
        onState: () => {},
        onCluster: (s) => clusters.push(s.machine?.redundancy ?? false),
        onSession: () => {},
      },
      () => 0,
    );
    void client.start();
    await tick();
    await tick();
    const socket = FakeSocket.instances[0] as FakeSocket;
    socket.open();
    socket.deliver(snapshot(1));
    socket.deliver({ t: "controlApplied", ...env, seq: 3, at: 2, op: "resumeAll", nodeIds: [] });
    await new Promise((r) => setTimeout(r, 5));
    await tick();
    await tick();
    expect(client.send({ t: "setRedundancy", on: true })).toBe(true);
    expect(clusters.at(-1)).toBe(true);
    const next = FakeSocket.instances[1] as FakeSocket;
    next.open();
    next.deliver(snapshot(4)); // still says off: the control has not reached the machine yet
    await new Promise((r) => setTimeout(r, CONTROL_SPACING_MS + 10));
    expect(next.frames().map((f) => f.t)).toEqual(["subscribe", "setRedundancy"]);
    expect(clusters.at(-1)).toBe(true);
    client.stop();
  });

  test("a held control older than the hold window is dropped, not fired late", async () => {
    const { client, socket } = await live();
    socket.deliver({ t: "controlApplied", ...env, seq: 3, at: 2, op: "resumeAll", nodeIds: [] });
    await new Promise((r) => setTimeout(r, 5));
    await tick();
    await tick();
    expect(client.send({ t: "freezeHalf" })).toBe(true);
    const realNow = Date.now;
    Date.now = () => realNow() + CONTROL_HOLD_MS + 1;
    try {
      const next = FakeSocket.instances[1] as FakeSocket;
      next.open();
      next.deliver(snapshot(4));
      await new Promise((r) => setTimeout(r, CONTROL_SPACING_MS + 10));
      expect(next.frames().map((f) => f.t)).toEqual(["subscribe"]);
    } finally {
      Date.now = realNow;
    }
    client.stop();
  });

  test("a control against a machine that is off is refused outright", async () => {
    const states: string[] = [];
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ off: true }),
    })) as unknown as typeof fetch;
    const client = new ObserverClient("https://session.example", {
      onState: (s) => states.push(s),
      onCluster: () => {},
      onSession: () => {},
    });
    void client.start();
    await tick();
    await tick();
    expect(states).toContain("off");
    expect(client.send({ t: "killHalf" })).toBe(false);
    client.stop();
  });
});

describe("loop 3 (WP8.3)", () => {
  test("controls queued behind the spacing timer survive a silent resubscribe and go out once", async () => {
    const { client, socket } = await live();
    // Two clicks right after the subscribe: both wait behind the 250 ms spacing.
    expect(client.send({ t: "killHalf" })).toBe(true);
    expect(client.send({ t: "stop" })).toBe(true);
    // A sequence gap before they went out: the client swaps sockets.
    socket.deliver({ t: "controlApplied", ...env, seq: 3, at: 2, op: "resumeAll", nodeIds: [] });
    await new Promise((r) => setTimeout(r, 5));
    await tick();
    await tick();
    const next = FakeSocket.instances[1] as FakeSocket;
    next.open();
    next.deliver(snapshot(4));
    await new Promise((r) => setTimeout(r, CONTROL_SPACING_MS * 3 + 20));
    const all = [...socket.frames(), ...next.frames()]
      .map((f) => f.t)
      .filter((t) => t !== "subscribe");
    expect(all.sort()).toEqual(["killHalf", "stop"]);
    client.stop();
  });

  test("a healthy session resets the reconnect backoff", async () => {
    const { client, socket } = await live();
    socket.close(1006, "");
    expect(client.lastDelayMs).toBe(LIMITS.reconnectMinMs);
    await new Promise((r) => setTimeout(r, LIMITS.reconnectMinMs + 20));
    await tick();
    await tick();
    const next = FakeSocket.instances[1] as FakeSocket;
    next.open();
    next.deliver(snapshot(2));
    next.close(1006, "");
    // Without the reset this would be the second step of the schedule, up to twice as long.
    expect(client.lastDelayMs).toBe(LIMITS.reconnectMinMs);
    client.stop();
  });

  test("a full machine is a state of its own, retried after the server's ten seconds", async () => {
    const { client, states, socket } = await live();
    socket.close(4008, "machine full: 14 clients; retry in 10 s");
    expect(states.at(-1)).toBe("full");
    expect(client.lastDelayMs).toBe(MACHINE_FULL_RETRY_MS);
    client.stop();
  });
});
