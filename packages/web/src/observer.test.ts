import { describe, expect, test } from "bun:test";
import { LIMITS } from "@tabframe/protocol";
import { env, snapshot } from "./fixtures.ts";
import {
  CONTROL_HOLD_MS,
  CONTROL_SPACING_MS,
  MACHINE_FULL_RETRY_MS,
  ObserverClient,
  type ObserverDeps,
  type WebSocketLike,
} from "./observer.ts";

// A control clicked while the socket is between subscribes (a silent resubscribe after a gap or
// a refresh, a rotation) is held for the next live socket instead of being dropped.

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  readonly url: string;
  readonly protocols: string[] | undefined;
  constructor(url: string, protocols?: string[]) {
    this.url = url;
    this.protocols = protocols;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  deliver(msg: Record<string, unknown>): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(msg) }));
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }
  frames(): Array<{ t: string }> {
    return this.sent.map((s) => JSON.parse(s) as { t: string });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

const onSession = { endpoint: "wss://cp.example", token: "local", storeBase: "https://s/blob" };

/** A client over fake sockets and a session that answers `body`, with a clock the test can move. */
function harness(body: Record<string, unknown> = onSession) {
  const sockets: FakeSocket[] = [];
  const states: string[] = [];
  const clusters: boolean[] = [];
  let offset = 0;
  const deps: ObserverDeps = {
    random: () => 0,
    now: () => Date.now() + offset,
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ...body, generation: 2, expiresAt: Date.now() + 60_000 }),
    }),
    socket: (url, protocols) => {
      const s = new FakeSocket(url, protocols);
      sockets.push(s);
      return s;
    },
  };
  const client = new ObserverClient(
    "https://session.example",
    {
      onState: (s) => states.push(s),
      onCluster: (s) => clusters.push(s.machine?.redundancy ?? false),
      onSession: () => {},
    },
    deps,
  );
  return {
    client,
    sockets,
    states,
    clusters,
    socket: (i: number) => sockets[i] as FakeSocket,
    advance: (ms: number) => {
      offset += ms;
    },
  };
}

async function live(h: ReturnType<typeof harness>): Promise<FakeSocket> {
  void h.client.start();
  await tick();
  await tick();
  const socket = h.socket(0);
  socket.open();
  socket.deliver(snapshot(1));
  expect(h.states).toContain("live");
  return socket;
}

/** A sequence gap: the client resubscribes through a new socket at once, silently. */
async function gap(h: ReturnType<typeof harness>, socket: FakeSocket): Promise<void> {
  socket.deliver({ t: "controlApplied", ...env, seq: 3, at: 2, op: "resumeAll", nodeIds: [] });
  await new Promise((r) => setTimeout(r, 5));
  await tick();
  await tick();
  expect(h.sockets.length).toBe(2);
}

describe("controls across a resubscribe", () => {
  test("a control issued during a silent resubscribe goes out on the next live socket", async () => {
    const h = harness();
    const socket = await live(h);
    // Between the close and the next snapshot the page still says live.
    await gap(h, socket);
    expect(h.client.connected).toBe(false);
    expect(h.client.send({ t: "killHalf" })).toBe(true);
    const next = h.socket(1);
    next.open();
    next.deliver(snapshot(4));
    // Controls are spaced under the observer rate; the held one follows the subscribe.
    await new Promise((r) => setTimeout(r, CONTROL_SPACING_MS + 10));
    expect(next.frames().map((f) => f.t)).toEqual(["subscribe", "killHalf"]);
    expect(socket.frames().map((f) => f.t)).toEqual(["subscribe"]);
    h.client.stop();
  });

  test("a held redundancy toggle shows its value again after the snapshot that revived the socket", async () => {
    const h = harness();
    const socket = await live(h);
    await gap(h, socket);
    expect(h.client.send({ t: "setRedundancy", on: true })).toBe(true);
    expect(h.clusters.at(-1)).toBe(true);
    const next = h.socket(1);
    next.open();
    next.deliver(snapshot(4)); // still says off: the control has not reached the machine yet
    await new Promise((r) => setTimeout(r, CONTROL_SPACING_MS + 10));
    expect(next.frames().map((f) => f.t)).toEqual(["subscribe", "setRedundancy"]);
    expect(h.clusters.at(-1)).toBe(true);
    h.client.stop();
  });

  test("a held control older than the hold window is dropped, not fired late", async () => {
    const h = harness();
    const socket = await live(h);
    await gap(h, socket);
    expect(h.client.send({ t: "freezeHalf" })).toBe(true);
    h.advance(CONTROL_HOLD_MS + 1);
    const next = h.socket(1);
    next.open();
    next.deliver(snapshot(4));
    await new Promise((r) => setTimeout(r, CONTROL_SPACING_MS + 10));
    expect(next.frames().map((f) => f.t)).toEqual(["subscribe"]);
    h.client.stop();
  });

  test("a control against a machine that is off is refused outright", async () => {
    const h = harness({ off: true });
    void h.client.start();
    await tick();
    await tick();
    expect(h.states).toContain("off");
    expect(h.client.send({ t: "killHalf" })).toBe(false);
    h.client.stop();
  });
});

describe("the socket's second and third loops", () => {
  test("controls queued behind the spacing timer survive a silent resubscribe and go out once", async () => {
    const h = harness();
    const socket = await live(h);
    // Two clicks right after the subscribe: both wait behind the 250 ms spacing.
    expect(h.client.send({ t: "killHalf" })).toBe(true);
    expect(h.client.send({ t: "stop" })).toBe(true);
    // A sequence gap before they went out: the client swaps sockets.
    await gap(h, socket);
    const next = h.socket(1);
    next.open();
    next.deliver(snapshot(4));
    await new Promise((r) => setTimeout(r, CONTROL_SPACING_MS * 3 + 20));
    const all = [...socket.frames(), ...next.frames()]
      .map((f) => f.t)
      .filter((t) => t !== "subscribe");
    expect(all.sort()).toEqual(["killHalf", "stop"]);
    h.client.stop();
  });

  test("a healthy session resets the reconnect backoff", async () => {
    const h = harness();
    const socket = await live(h);
    socket.close(1006, "");
    expect(h.client.lastDelayMs).toBe(LIMITS.reconnectMinMs);
    await new Promise((r) => setTimeout(r, LIMITS.reconnectMinMs + 20));
    await tick();
    await tick();
    const next = h.socket(1);
    next.open();
    next.deliver(snapshot(2));
    next.close(1006, "");
    // Without the reset this would be the second step of the schedule, up to twice as long.
    expect(h.client.lastDelayMs).toBe(LIMITS.reconnectMinMs);
    h.client.stop();
  });

  test("a full machine is a state of its own, retried after the server's ten seconds", async () => {
    const h = harness();
    const socket = await live(h);
    socket.close(4008, "machine full: 14 clients; retry in 10 s");
    expect(h.states.at(-1)).toBe("full");
    expect(h.client.lastDelayMs).toBe(MACHINE_FULL_RETRY_MS);
    h.client.stop();
  });
});
