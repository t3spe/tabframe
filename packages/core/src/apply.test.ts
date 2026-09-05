import { describe, expect, test } from "bun:test";
import { CLOSE, LIMITS, PROTOCOL_VERSION } from "@tabframe/protocol";
import fc from "fast-check";
import type { Effect } from "./events.ts";
import { H, harness } from "./harness.ts";
import type { Ledger } from "./ledger.ts";
import { PRESIGN_BYTES_PER_MIN, SOLICITED_RATE } from "./policy.ts";

/** The wire gate (design §6.2, §6.4, §8.4): handshakes, liveness, refusals, and budgets. */

const GEN = 3;

const sends = (effects: Effect[], connId?: string) =>
  effects.filter((e) => e.kind === "send" && (connId === undefined || e.connId === connId));
const closes = (effects: Effect[]) => effects.filter((e) => e.kind === "close");
const types = (effects: Effect[]) => sends(effects).map((e) => (e.kind === "send" ? e.msg.t : ""));

describe("handshake", () => {
  test("hello gets a welcome and observers see nodeJoined with a sequence number", () => {
    const h = harness();
    h.subscribe("o1");
    const effects = h.hello("c1");
    const welcome = sends(effects, "c1")[0];
    expect(welcome?.kind === "send" && welcome.msg.t === "welcome" && welcome.msg.nodeId).toBe(
      "n1",
    );
    expect(welcome?.kind === "send" && welcome.msg.t === "welcome" && welcome.msg.storeBase).toBe(
      "https://cdn.test/blob",
    );
    const joined = sends(effects, "o1")[0];
    expect(joined?.kind === "send" && joined.msg.t === "nodeJoined" && joined.msg.seq).toBe(1);
    expect(joined?.kind === "send" && joined.msg.t === "nodeJoined" && joined.msg.node.nodeId).toBe(
      "n1",
    );
    expect(h.ledger.nodes.size).toBe(1);
  });

  test("subscribe returns a snapshot of the current nodes and ping returns pong with the seq", () => {
    const h = harness();
    h.hello("c1");
    h.hello("c2", "h2", "core");
    const snap = h.subscribe("o1");
    expect(types(snap)).toEqual(["snapshot"]);
    const msg = snap[0]?.kind === "send" ? snap[0].msg : undefined;
    expect(msg?.t === "snapshot" && msg.nodes?.map((n) => n.nodeId)).toEqual(["n1", "n2"]);
    expect(msg?.t === "snapshot" && msg.pages).toBe(1);
    const pong = h.send("o1", { t: "ping" });
    expect(pong[0]?.kind === "send" && pong[0].msg.t === "pong" && pong[0].msg.seq).toBe(
      h.ledger.meta.seq,
    );
  });

  test("duplicate hello, heartbeat before hello, ping before subscribe are refused", () => {
    const h = harness();
    h.hello("c1");
    expect(
      closes(
        h.send("c1", { t: "hello", hostId: "h", kind: "tab", cores: 1, sandboxVersion: "1" }),
      )[0],
    ).toMatchObject({ code: CLOSE.invalidMessage });
    h.connect("c2", "node");
    expect(closes(h.heartbeat("c2"))[0]).toMatchObject({
      code: CLOSE.invalidMessage,
      reason: "heartbeat before hello",
    });
    h.connect("o1", "observer");
    expect(closes(h.send("o1", { t: "ping" }))[0]).toMatchObject({ code: CLOSE.invalidMessage });
  });

  test("messages from unknown connections are ignored", () => {
    const h = harness();
    expect(h.send("ghost", { t: "ping" })).toEqual([]);
  });
});

describe("liveness", () => {
  test("heartbeats keep a node alive; silence beyond the timeout makes it gone", () => {
    const h = harness();
    h.subscribe("o1");
    h.hello("c1");
    h.advance(3_000);
    h.heartbeat("c1");
    h.advance(LIMITS.goneAfterMs);
    expect(h.tick()).toEqual([]);
    h.advance(1);
    const effects = h.tick();
    expect(closes(effects)[0]).toMatchObject({ connId: "c1", code: CLOSE.declaredGone });
    const left = sends(effects, "o1")[0];
    expect(left?.kind === "send" && left.msg.t === "nodeLeft" && left.msg.reason).toBe("silent");
    expect(h.ledger.nodes.size).toBe(0);
    expect(h.ledger.conns.has("c1")).toBe(false);
  });

  test("a closed socket announces nodeLeft with reason closed", () => {
    const h = harness();
    h.subscribe("o1");
    h.hello("c1");
    const effects = h.disconnect("c1");
    const left = sends(effects, "o1")[0];
    expect(left?.kind === "send" && left.msg.t === "nodeLeft" && left.msg.reason).toBe("closed");
    expect(h.ledger.nodes.size).toBe(0);
  });

  test("observers that stop pinging are dropped; nodes are not told", () => {
    const h = harness();
    h.subscribe("o1");
    h.hello("c1");
    h.advance(5 * LIMITS.observerPingMs + 1);
    h.heartbeat("c1");
    const effects = h.tick();
    expect(closes(effects).map((e) => e.connId)).toEqual(["o1"]);
    expect(h.ledger.observers.size).toBe(0);
    expect(h.ledger.nodes.size).toBe(1);
  });

  test("connections that never handshake are closed after the timeout", () => {
    const h = harness();
    h.connect("c1", "node");
    h.advance(10_001);
    expect(closes(h.tick())[0]).toMatchObject({ connId: "c1", reason: "no hello" });
    expect(h.ledger.conns.size).toBe(0);
  });
});

describe("health from visibility", () => {
  test("hidden tab → throttled, visible again → fast, each announced once", () => {
    const h = harness();
    h.subscribe("o1");
    h.hello("c1");
    expect(types(h.heartbeat("c1", false))).toEqual(["nodeHealth"]);
    expect(h.ledger.nodes.get("n1")?.health).toBe("throttled");
    expect(h.heartbeat("c1", false)).toEqual([]);
    // Health is announced at most every two seconds per node, and heartbeats faster than half the
    // period are dropped: the flip back is announced once the window has passed.
    h.advance(2_000);
    expect(types(h.heartbeat("c1", true))).toEqual(["nodeHealth"]);
    expect(h.ledger.nodes.get("n1")?.health).toBe("fast");
  });
});

describe("refusals", () => {
  test("invalid JSON, wrong version, foreign generation", () => {
    const h = harness();
    h.connect("c1", "node");
    expect(closes(h.raw("c1", "{nope"))[0]).toMatchObject({ code: CLOSE.invalidMessage });
    h.connect("c2", "node");
    expect(closes(h.raw("c2", JSON.stringify({ t: "hello", v: 99, gen: GEN })))[0]).toMatchObject({
      code: CLOSE.versionMismatch,
    });
    h.connect("c3", "node");
    expect(
      closes(h.raw("c3", JSON.stringify({ t: "hello", v: PROTOCOL_VERSION, gen: GEN + 1 })))[0],
    ).toMatchObject({ code: CLOSE.generationMismatch });
    expect(h.ledger.conns.size).toBe(0);
  });

  test("node cap and observer cap", () => {
    const h = harness();
    for (let i = 0; i < LIMITS.nodeCap; i++) h.hello(`c${i}`);
    expect(h.ledger.nodes.size).toBe(LIMITS.nodeCap);
    expect(closes(h.hello("overflow"))[0]).toMatchObject({ code: CLOSE.nodeCap });
    for (let i = 0; i < LIMITS.observerCap; i++) h.subscribe(`o${i}`);
    expect(closes(h.subscribe("o-overflow"))[0]).toMatchObject({ code: CLOSE.observerCap });
  });

  test("message rate limit closes the connection", () => {
    const h = harness();
    h.hello("c1");
    let closed: Effect | undefined;
    for (let i = 0; i < LIMITS.nodeMessagesPerSecond + 5 && !closed; i++) {
      closed = closes(h.heartbeat("c1"))[0];
    }
    expect(closed).toMatchObject({ code: CLOSE.rateLimited });
    // A well-behaved node at one heartbeat per second is never limited.
    const g = harness();
    g.hello("c1");
    for (let i = 0; i < 100; i++) {
      g.advance(LIMITS.heartbeatMs);
      expect(closes(g.heartbeat("c1"))).toEqual([]);
    }
  });

  test("results and presigns have a bucket of their own: a burst passes, a flood does not", () => {
    // A fast node on small tiles reports dozens of results a second, each after a presign; the
    // solicited bucket is wide enough for that and bounded for a node that floods presigns.
    const h = harness();
    const hash = "a".repeat(64);
    h.hello("c1");
    for (let i = 0; i < SOLICITED_RATE / 2; i++) {
      expect(closes(h.send("c1", { t: "presign", items: [{ hash, size: 1 }] }))).toEqual([]);
      const result = {
        t: "result",
        taskId: `t${i}`,
        attempt: 1,
        output: hash,
        outputSize: 1,
        writes: [],
        log: null,
        computeMs: 1,
      };
      expect(closes(h.send("c1", result))).toEqual([]);
    }
    expect(h.ledger.nodes.size).toBe(1);
    let flooded: Effect | undefined;
    for (let i = 0; i < SOLICITED_RATE + 5 && !flooded; i++)
      flooded = closes(h.send("c1", { t: "presign", items: [{ hash, size: 1 }] }))[0];
    expect(flooded).toMatchObject({ code: CLOSE.rateLimited });
    h.hello("c1b");
    // Unsolicited traffic is still limited after that burst.
    let closed: Effect | undefined;
    for (let i = 0; i < LIMITS.nodeMessagesPerSecond + 5 && !closed; i++) {
      closed = closes(h.heartbeat("c1b"))[0];
    }
    expect(closed).toMatchObject({ code: CLOSE.rateLimited });
    // Observers keep their own budget.
    const g = harness();
    g.subscribe("o1");
    let closedObserver: Effect | undefined;
    for (let i = 0; i < LIMITS.observerMessagesPerSecond + 5 && !closedObserver; i++) {
      closedObserver = closes(g.send("o1", { t: "ping" }))[0];
    }
    expect(closedObserver).toMatchObject({ code: CLOSE.rateLimited });
  });
});

describe("presign budgets", () => {
  test("a connection's presigned bytes are a refilling budget", () => {
    const h = harness();
    h.hello("c1", "h1");
    const hash = "b".repeat(64);
    // Each item is at the protocol's cap; the minute's budget runs out after a bounded number of
    // them, and comes back with the next minute — so an honest core rendering all day is never closed.
    const perItem = LIMITS.maxOutputBytes;
    const allowed = Math.floor(PRESIGN_BYTES_PER_MIN / perItem);
    let closedAt = -1;
    for (let i = 0; i < allowed + 2 && closedAt < 0; i++) {
      const fx = h.send("c1", { t: "presign", items: [{ hash, size: perItem }] });
      if (fx.some((e) => e.kind === "close")) closedAt = i;
      else expect(fx.some((e) => e.kind === "presign")).toBe(true);
    }
    expect(closedAt).toBe(allowed);
    h.hello("c2", "h2");
    for (let i = 0; i < allowed; i++) {
      expect(
        h
          .send("c2", { t: "presign", items: [{ hash, size: perItem }] })
          .some((e) => e.kind === "presign"),
      ).toBe(true);
    }
    h.advance(60_000);
    expect(
      h
        .send("c2", { t: "presign", items: [{ hash, size: perItem }] })
        .some((e) => e.kind === "presign"),
    ).toBe(true);
  });

  test("a node over the machine budget gets an empty presign and stays connected; an observer gets an error", () => {
    const h = harness();
    h.subscribe("o1");
    h.hello("c1", "h1");
    h.ledger.session.presignItems.tokens = 0;
    h.ledger.session.presignItems.refilledAt = h.now;
    const node = h.send("c1", { t: "presign", items: [{ hash: H("f"), size: 10 }] });
    expect(node).toEqual([
      {
        kind: "send",
        connId: "c1",
        msg: { t: "presigned", v: PROTOCOL_VERSION, gen: h.gen, urls: [] },
      },
    ]);
    expect(node.some((e) => e.kind === "close")).toBe(false);
    const obs = h.send("o1", { t: "presign", items: [{ hash: H("f"), size: 10 }] });
    expect(obs.some((e) => e.kind === "send" && e.msg.t === "error")).toBe(true);
    expect(obs.some((e) => e.kind === "close")).toBe(false);
    // A connection over its own budget is still closed.
    h.ledger.session.presignItems.tokens = 10_000;
    const conn = h.ledger.conns.get("c1");
    if (conn) conn.presignBytes.tokens = 0;
    const closed = h.send("c1", { t: "presign", items: [{ hash: H("f"), size: 10 }] });
    expect(closed.some((e) => e.kind === "close" && e.code === CLOSE.rateLimited)).toBe(true);
  });
});

describe("invariants under random activity", () => {
  type Op =
    | { op: "connect"; id: number }
    | { op: "hello"; id: number }
    | { op: "heartbeat"; id: number }
    | { op: "disconnect"; id: number }
    | { op: "advance"; ms: number }
    | { op: "tick" };

  const arbOp: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ op: fc.constant("connect" as const), id: fc.integer({ min: 0, max: 12 }) }),
    fc.record({ op: fc.constant("hello" as const), id: fc.integer({ min: 0, max: 12 }) }),
    fc.record({ op: fc.constant("heartbeat" as const), id: fc.integer({ min: 0, max: 12 }) }),
    fc.record({ op: fc.constant("disconnect" as const), id: fc.integer({ min: 0, max: 12 }) }),
    fc.record({ op: fc.constant("advance" as const), ms: fc.integer({ min: 1, max: 3_000 }) }),
    fc.record({ op: fc.constant("tick" as const) }),
  );

  function check(ledger: Ledger, now: number, effects: Effect[], lastSeq: number, ticked: boolean) {
    for (const [connId, nodeId] of ledger.nodeByConn) {
      expect(ledger.nodes.get(nodeId)?.connId).toBe(connId);
      expect(ledger.conns.has(connId)).toBe(true);
    }
    for (const node of ledger.nodes.values()) {
      expect(ledger.nodeByConn.get(node.connId)).toBe(node.nodeId);
      if (ticked) expect(now - node.lastSeen).toBeLessThanOrEqual(LIMITS.goneAfterMs);
    }
    expect(ledger.meta.seq).toBeGreaterThanOrEqual(lastSeq);
    for (const e of effects) {
      if (e.kind === "send")
        expect(ledger.conns.has(e.connId) || ledger.observers.has(e.connId)).toBe(true);
    }
  }

  test("ledger maps stay consistent, nothing gone survives a tick, seq is monotonic", () => {
    fc.assert(
      fc.property(fc.array(arbOp, { minLength: 1, maxLength: 200 }), (ops) => {
        const h = harness();
        h.subscribe("observer");
        let lastSeq = 0;
        for (const op of ops) {
          let effects: Effect[] = [];
          let ticked = false;
          switch (op.op) {
            case "connect":
              effects = h.connect(`c${op.id}`, "node");
              break;
            case "hello":
              effects = h.send(`c${op.id}`, {
                t: "hello",
                hostId: `h${op.id % 3}`,
                kind: "tab",
                cores: 4,
                sandboxVersion: "1",
              });
              break;
            case "heartbeat":
              effects = h.heartbeat(`c${op.id}`);
              break;
            case "disconnect":
              effects = h.disconnect(`c${op.id}`);
              break;
            case "advance":
              h.advance(op.ms);
              break;
            case "tick":
              effects = h.tick();
              ticked = true;
              break;
          }
          check(h.ledger, h.now, effects, lastSeq, ticked);
          lastSeq = h.ledger.meta.seq;
        }
      }),
      { numRuns: 200 },
    );
  });
});
