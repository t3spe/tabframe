import { describe, expect, test } from "bun:test";
import {
  decodeRunInput,
  type FsManifest,
  LIMITS,
  PROTOCOL_VERSION,
  RELEASED,
} from "@tabframe/protocol";
import type { HostRequest, TaskResult } from "@tabframe/sandbox";
import { type PresignRequester, StoreClient, sha256Hex } from "@tabframe/store";
import {
  fromBase64,
  hostFailure,
  type SandboxRunner,
  SocketPresigner,
  TaskRunner,
} from "./tasks.ts";

const BASE = "http://store.test/blob";
const PROGRAM = "a".repeat(64);
const ROOT = "c".repeat(64);
const limits = {
  maxOutputBytes: 1 << 20,
  maxWriteBytes: 1 << 20,
  maxWriteFiles: 16,
  maxLogBytes: 1 << 16,
  memoryPagesMax: 256,
};

function world(results: TaskResult[]) {
  const blobs = new Map<string, Uint8Array>();
  const gets: string[] = [];
  const puts: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const hash = url.slice(BASE.length + 1);
    if (init?.method === "PUT") {
      puts.push(hash);
      blobs.set(hash, new Uint8Array(init.body as ArrayBuffer));
      return new Response(null, { status: 200 });
    }
    gets.push(hash);
    const b = blobs.get(hash);
    return b
      ? new Response(b as unknown as BodyInit, { status: 200 })
      : new Response(null, { status: 404 });
  };
  const presigns: number[] = [];
  const requester: PresignRequester = {
    presign: async (items) => {
      presigns.push(items.length);
      return items.map((i) => ({
        hash: i.hash,
        url: blobs.has(i.hash) ? null : `${BASE}/${i.hash}`,
        headers: {},
      }));
    },
  };
  const requests: HostRequest[] = [];
  let created = 0;
  let disposed = 0;
  const sandbox: SandboxRunner = {
    run: async (_m, request) => {
      requests.push(request);
      return results.shift() ?? { ok: false, error: "no scripted result", log: "" };
    },
    dispose: () => {
      disposed += 1;
    },
  };
  let compiled = 0;
  let clock = 1_000;
  const runner = new TaskRunner({
    store: new StoreClient(BASE, requester, fetchImpl),
    createSandbox: () => {
      created += 1;
      return sandbox;
    },
    compile: async () => {
      compiled += 1;
      return {} as WebAssembly.Module;
    },
    now: () => clock,
  });
  blobs.set(PROGRAM, new Uint8Array([0, 97, 115, 109]));
  return {
    runner,
    blobs,
    gets,
    puts,
    presigns,
    requests,
    counts: () => ({ created, disposed, compiled }),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const assign = (extra: Record<string, unknown> = {}) =>
  ({
    t: "assign" as const,
    v: PROTOCOL_VERSION,
    gen: 1,
    taskId: "t1",
    attempt: 2,
    executionId: "e1",
    program: PROGRAM,
    kind: "run" as const,
    stage: 1,
    index: 3,
    count: 10,
    input: Buffer.from([7, 8]).toString("base64"),
    fsRoot: null,
    deadlineMs: 2_000,
    limits,
    ...extra,
  }) as Parameters<TaskRunner["run"]>[0];

describe("TaskRunner", () => {
  test("frames run input, passes plan input through, fetches and compiles the module once", async () => {
    const w = world([
      { ok: true, output: new Uint8Array([1]), writes: new Map(), log: "", computeMs: 4 },
      { ok: true, output: new Uint8Array([2]), writes: new Map(), log: "", computeMs: 4 },
    ]);
    await w.runner.run(assign(), 1);
    await w.runner.run(assign({ kind: "plan", taskId: "t2" }), 1);
    expect(w.gets).toEqual([PROGRAM]);
    expect(w.counts().compiled).toBe(1);
    expect(w.counts().created).toBe(1);
    expect(decodeRunInput((w.requests[0] as HostRequest).input)).toEqual({
      stage: 1,
      taskIndex: 3,
      taskCount: 10,
      input: new Uint8Array([7, 8]),
    });
    expect((w.requests[1] as HostRequest).input).toEqual(new Uint8Array([7, 8]));
  });

  test("fetches the stage manifest by fsRoot and caches it; null root means no files", async () => {
    const w = world([
      { ok: true, output: new Uint8Array([1]), writes: new Map(), log: "", computeMs: 4 },
      { ok: true, output: new Uint8Array([1]), writes: new Map(), log: "", computeMs: 4 },
      { ok: true, output: new Uint8Array([1]), writes: new Map(), log: "", computeMs: 4 },
    ]);
    const manifest: FsManifest = {
      version: 1,
      files: { "/in/x": { hash: "d".repeat(64), size: 3 } },
    };
    w.blobs.set(ROOT, new TextEncoder().encode(JSON.stringify(manifest)));
    await w.runner.run(assign({ fsRoot: ROOT }), 1);
    await w.runner.run(assign({ fsRoot: ROOT, taskId: "t2" }), 1);
    await w.runner.run(assign({ taskId: "t3" }), 1);
    expect(w.gets.filter((g) => g === ROOT)).toEqual([ROOT]);
    expect((w.requests[0] as HostRequest).manifest).toEqual(manifest);
    expect((w.requests[2] as HostRequest).manifest).toEqual({ version: 1, files: {} });
  });

  test("uploads output, writes, and an oversized log; the result carries hashes and sizes", async () => {
    const output = new Uint8Array(100).fill(7);
    const w1 = new Uint8Array([1, 2, 3]);
    const w2 = new Uint8Array([4]);
    const log = "x".repeat(LIMITS.maxInlineLogBytes + 1);
    const w = world([
      {
        ok: true,
        output,
        writes: new Map([
          ["/out/b", w2],
          ["/out/a", w1],
        ]),
        log,
        computeMs: 42,
      },
    ]);
    const outcome = await w.runner.run(assign(), 1);
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") return;
    const m = outcome.msg;
    expect(m.output).toBe(await sha256Hex(output));
    expect(m.outputSize).toBe(100);
    expect(m.writes).toEqual([
      { path: "/out/b", hash: await sha256Hex(w2), size: 1 },
      { path: "/out/a", hash: await sha256Hex(w1), size: 3 },
    ]);
    expect(m.log).toEqual({ hash: await sha256Hex(new TextEncoder().encode(log)) });
    expect(m.computeMs).toBe(42);
    expect(m.error).toBeUndefined();
    expect(w.presigns).toEqual([4]); // one round trip for everything
    expect(w.puts.length).toBe(4);
    expect(w.blobs.get(m.output as string)).toEqual(output);
  });

  test("a short log stays inline and an empty one is null; compute is whole milliseconds, at least one", async () => {
    const w = world([
      { ok: true, output: new Uint8Array([1]), writes: new Map(), log: "note", computeMs: 0 },
      { ok: true, output: new Uint8Array([1]), writes: new Map(), log: "", computeMs: 9.6 },
    ]);
    const a = await w.runner.run(assign(), 1);
    const b = await w.runner.run(assign({ taskId: "t2" }), 1);
    if (a.kind !== "result" || b.kind !== "result") throw new Error("expected results");
    expect(a.msg.log).toEqual({ text: "note" });
    expect(a.msg.computeMs).toBe(1);
    expect(b.msg.computeMs).toBe(10);
    expect(b.msg.log).toBeNull();
    expect(w.puts.length).toBe(1); // the second output was already in the store
  });

  test("a trap is an error result with the log; a deadline kill or a host failure is released; disposed is dropped", async () => {
    const w = world([
      { ok: false, error: "trap: unreachable", log: "before the trap" },
      { ok: false, error: "deadline", log: "" },
      {
        ok: false,
        error:
          "WebAssembly.Instance(): Out of memory: Cannot allocate Wasm memory for new instance",
        log: "",
      },
      { ok: false, error: "disposed", log: "" },
    ]);
    const trap = await w.runner.run(assign(), 1);
    expect(trap).toMatchObject({
      kind: "result",
      msg: { error: "trap: unreachable", log: { text: "before the trap" }, writes: [] },
    });
    const late = await w.runner.run(assign(), 1);
    expect(late).toMatchObject({ kind: "result", msg: { error: RELEASED } });
    // The host could not run the module at all: not the program's fault, another node's turn.
    const starved = await w.runner.run(assign(), 1);
    expect(starved).toMatchObject({ kind: "result", msg: { error: RELEASED } });
    const gone = await w.runner.run(assign(), 1);
    expect(gone).toEqual({ kind: "dropped", reason: "cancelled" });
    expect(w.puts).toEqual([]);
  });

  test("a missing module or manifest fails the task as a node error and is retried next time", async () => {
    const w = world([
      { ok: true, output: new Uint8Array([1]), writes: new Map(), log: "", computeMs: 1 },
    ]);
    const missing = await w.runner.run(assign({ program: "b".repeat(64) }), 1);
    expect(missing).toMatchObject({
      kind: "result",
      msg: { error: expect.stringContaining("node:") },
    });
    const noRoot = await w.runner.run(assign({ fsRoot: ROOT }), 1);
    expect(noRoot).toMatchObject({
      kind: "result",
      msg: { error: expect.stringContaining("manifest") },
    });
    // The failed fetch is not cached: once the store has it, the task runs.
    w.blobs.set(ROOT, new TextEncoder().encode(JSON.stringify({ version: 1, files: {} })));
    const ok = await w.runner.run(assign({ fsRoot: ROOT }), 1);
    expect(ok.kind).toBe("result");
    expect(w.gets.filter((g) => g === ROOT).length).toBe(2);
  });

  test("abort disposes the sandbox and the next task gets a fresh one", async () => {
    const w = world([
      { ok: true, output: new Uint8Array([1]), writes: new Map(), log: "", computeMs: 1 },
      { ok: true, output: new Uint8Array([1]), writes: new Map(), log: "", computeMs: 1 },
    ]);
    await w.runner.run(assign(), 1);
    w.runner.abort();
    expect(w.counts().disposed).toBe(1);
    await w.runner.run(assign(), 1);
    expect(w.counts().created).toBe(2);
    expect(w.runner.runningTaskId).toBeNull();
  });
});

describe("SocketPresigner", () => {
  test("sends a presign message with the generation and resolves on the matching presigned", async () => {
    const sent: string[] = [];
    const p = new SocketPresigner((t) => sent.push(t));
    p.setGeneration(7);
    const items = [{ hash: "a".repeat(64), size: 3 }];
    const pending = p.presign(items);
    expect(JSON.parse(sent[0] as string)).toEqual({
      t: "presign",
      v: PROTOCOL_VERSION,
      gen: 7,
      items,
    });
    expect(p.deliver([{ hash: "b".repeat(64), url: null, headers: {} }])).toBe(false);
    const urls = [{ hash: "a".repeat(64), url: null, headers: {} }];
    expect(p.deliver(urls)).toBe(true);
    expect(await pending).toEqual(urls);
    expect(p.deliver(urls)).toBe(false); // nothing outstanding
  });

  test("one outstanding request at a time; reset rejects it", async () => {
    const p = new SocketPresigner(() => {});
    const first = p.presign([{ hash: "a".repeat(64), size: 1 }]);
    await expect(p.presign([{ hash: "b".repeat(64), size: 1 }])).rejects.toThrow(
      "already outstanding",
    );
    p.reset();
    await expect(first).rejects.toThrow("socket closed");
  });
});

describe("fromBase64", () => {
  test("matches Buffer for lengths 0..64 and ignores padding", () => {
    for (let n = 0; n <= 64; n++) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255);
      const text = Buffer.from(bytes).toString("base64");
      expect(fromBase64(text)).toEqual(bytes);
      expect(fromBase64(text.replace(/=+$/, ""))).toEqual(bytes);
    }
  });
});

describe("host and store failures are releases, not program faults (WP8.1)", () => {
  test("a fetch that failed, an upload that failed, a presign that timed out: released; a trap: a fault", () => {
    expect(hostFailure("Error: fetch of abc failed: 503")).toBe(true);
    expect(hostFailure("Error: upload of abc failed: 500")).toBe(true);
    expect(hostFailure("Error: presign timed out")).toBe(true);
    // What the program says about itself is a program fault, whatever words it uses (WP8.2).
    expect(hostFailure("abort: out of memory in tile 4 (assembly/index.ts:10:3)")).toBe(false);
    expect(hostFailure("trap: unreachable network error")).toBe(false);
    expect(hostFailure("link: fetch of x failed")).toBe(false);
    expect(hostFailure("TypeError: Failed to fetch")).toBe(true);
    expect(hostFailure("abort: this planner refuses to plan")).toBe(false);
    expect(hostFailure("RuntimeError: unreachable")).toBe(false);
  });

  test("a presign nobody answers rejects after the timeout instead of holding the node for ever", async () => {
    const sent: string[] = [];
    const presigner = new SocketPresigner((text) => sent.push(text), 20);
    await expect(presigner.presign([{ hash: "a".repeat(64), size: 1 }])).rejects.toThrow(
      "presign timed out",
    );
    expect(sent.length).toBe(1);
    const p = presigner.presign([{ hash: "b".repeat(64), size: 1 }]);
    expect(presigner.deliver([{ hash: "b".repeat(64), url: null, headers: {} }])).toBe(true);
    expect((await p)[0]?.hash).toBe("b".repeat(64));
  });
});

test("a module fetch that hangs releases the task at the deadline instead of holding it for ever (WP8.3)", async () => {
  const runner = new TaskRunner({
    store: new StoreClient(
      BASE,
      { presign: async () => [] },
      (() => new Promise<Response>(() => {})) as unknown as typeof fetch,
    ),
    createSandbox: () => ({
      run: async () => ({ ok: false, error: "never runs", log: "" }),
      dispose: () => {},
    }),
    compile: async () => ({}) as WebAssembly.Module,
    now: () => 0,
  });
  const started = Date.now();
  const outcome = await runner.run(assign({ deadlineMs: 50 }), 1);
  expect(outcome).toMatchObject({ kind: "result", msg: { error: RELEASED, computeMs: 0 } });
  expect(Date.now() - started).toBeLessThan(3_000);
});
