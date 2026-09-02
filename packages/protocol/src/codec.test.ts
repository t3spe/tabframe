import { describe, expect, test } from "bun:test";
import { decode, encode } from "./codec.ts";
import { CLOSE } from "./codes.ts";
import { LIMITS, PROTOCOL_VERSION } from "./limits.ts";
import { controlPlaneToNode, heartbeat, hello, nodeToControlPlane, welcome } from "./node.ts";
import {
  controlPlaneToObserver,
  nodeJoined,
  nodeLeft,
  observerToControlPlane,
  ping,
  pong,
  snapshot,
  subscribe,
} from "./observer.ts";

const gen = 7;
const base = { v: PROTOCOL_VERSION, gen } as const;

const samples = {
  hello: { t: "hello", ...base, hostId: "h1", kind: "tab", cores: 8, sandboxVersion: "1" },
  heartbeat: { t: "heartbeat", ...base, visible: true, queue: 1, lastTaskMs: 143, tasksDone: 12 },
  welcome: {
    t: "welcome",
    ...base,
    nodeId: "n1",
    heartbeatMs: 1000,
    maxInFlight: 2,
    storeBase: "https://d1.cloudfront.net/blob",
  },
  subscribe: { t: "subscribe", ...base, since: 41 },
  ping: { t: "ping", ...base },
  pong: { t: "pong", ...base, seq: 41 },
  snapshot: {
    t: "snapshot",
    ...base,
    seq: 41,
    page: 0,
    pages: 1,
    at: 1_756_700_000_000,
    tasks: [],
    nodes: [
      {
        nodeId: "n1",
        hostId: "h1",
        kind: "core",
        health: "fast",
        visible: true,
        tasksDone: 3,
        lastTaskMs: null,
        inFlight: 2,
        joinedAt: 1_756_699_000_000,
      },
    ],
  },
  nodeJoined: {
    t: "nodeJoined",
    ...base,
    seq: 42,
    node: {
      nodeId: "n2",
      hostId: "h1",
      kind: "tab",
      health: "fast",
      visible: true,
      tasksDone: 0,
      lastTaskMs: null,
      inFlight: 0,
      joinedAt: 1,
    },
  },
  nodeLeft: { t: "nodeLeft", ...base, seq: 43, nodeId: "n2", reason: "silent" },
} as const;

describe("round trips", () => {
  const cases: Array<[string, Parameters<typeof decode>[0], unknown]> = [
    ["hello", hello, samples.hello],
    ["heartbeat", heartbeat, samples.heartbeat],
    ["welcome", welcome, samples.welcome],
    ["subscribe", subscribe, samples.subscribe],
    ["ping", ping, samples.ping],
    ["pong", pong, samples.pong],
    ["snapshot", snapshot, samples.snapshot],
    ["nodeJoined", nodeJoined, samples.nodeJoined],
    ["nodeLeft", nodeLeft, samples.nodeLeft],
  ];
  for (const [name, schema, sample] of cases) {
    test(name, () => {
      const wire = encode(sample);
      const back = decode(schema, wire, { expectGen: gen });
      expect(back.ok).toBe(true);
      if (back.ok) expect(back.msg).toEqual(sample);
    });
  }
  test("unions dispatch on t", () => {
    expect(decode(nodeToControlPlane, encode(samples.hello)).ok).toBe(true);
    expect(decode(nodeToControlPlane, encode(samples.heartbeat)).ok).toBe(true);
    expect(decode(controlPlaneToNode, encode(samples.welcome)).ok).toBe(true);
    expect(decode(observerToControlPlane, encode(samples.ping)).ok).toBe(true);
    expect(decode(controlPlaneToObserver, encode(samples.snapshot)).ok).toBe(true);
    expect(decode(controlPlaneToObserver, encode(samples.nodeLeft)).ok).toBe(true);
  });
});

describe("rejections map to close codes", () => {
  test("binary frames", () => {
    const r = decode(hello, new Uint8Array([1, 2, 3]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.closeCode).toBe(CLOSE.invalidMessage);
  });
  test("oversized", () => {
    const big = { ...samples.hello, hostId: "x".repeat(64) };
    const r = decode(hello, encode(big), { maxBytes: 80 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("exceeds");
  });
  test("not JSON, not an object", () => {
    for (const raw of ["{nope", "[1,2]", "null", "42"]) {
      const r = decode(hello, raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.closeCode).toBe(CLOSE.invalidMessage);
    }
  });
  test("protocol version mismatch", () => {
    const r = decode(hello, JSON.stringify({ ...samples.hello, v: 2 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.closeCode).toBe(CLOSE.versionMismatch);
  });
  test("foreign generation", () => {
    const r = decode(hello, encode(samples.hello), { expectGen: gen + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.closeCode).toBe(CLOSE.generationMismatch);
      expect(r.reason).toContain("expected 8");
    }
  });
  test("generation is not checked unless asked", () => {
    expect(decode(hello, encode(samples.hello)).ok).toBe(true);
  });
  test("schema failures name the field", () => {
    const r = decode(heartbeat, encode({ ...samples.heartbeat, queue: LIMITS.maxInFlight + 1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.closeCode).toBe(CLOSE.invalidMessage);
      expect(r.reason).toContain("heartbeat");
      expect(r.reason).toContain("queue");
    }
  });
  test("unknown message type", () => {
    const r = decode(nodeToControlPlane, encode({ t: "bogus", ...base }));
    expect(r.ok).toBe(false);
  });
  test("wrong direction", () => {
    const r = decode(controlPlaneToNode, encode(samples.hello));
    expect(r.ok).toBe(false);
  });
});

describe("encode", () => {
  test("refuses to produce a frame over the cap", () => {
    expect(() => encode({ t: "x", ...base, blob: "y".repeat(LIMITS.maxMessageBytes) })).toThrow(
      /cap/,
    );
  });
  test("is canonical", () => {
    expect(encode({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });
});
