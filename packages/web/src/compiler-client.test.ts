import { describe, expect, test } from "bun:test";
import { CompilerClient, type StatusTone, type WorkerLike } from "./compiler-client.ts";
import type { CompileResult, WorkerReply, WorkerRequest } from "./compiler-types.ts";
import { ENTRY } from "./editor-core.ts";

class FakeWorker implements WorkerLike {
  static instances: FakeWorker[] = [];
  posted: WorkerRequest[] = [];
  terminated = false;
  onmessage: ((ev: MessageEvent<WorkerReply>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: ((ev: MessageEvent) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeWorker.instances.push(this);
  }
  postMessage(message: WorkerRequest): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(data: WorkerReply): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
  die(message: string): void {
    this.onerror?.(new ErrorEvent("error", { message }));
  }
}

const compiled = (id: number, extra: Partial<CompileResult> = {}): WorkerReply => ({
  type: "compiled",
  id,
  ok: true,
  wasm: new Uint8Array([0, 0x61, 0x73, 0x6d]),
  diagnostics: [],
  stderr: "",
  ms: 7,
  ...extra,
});

function harness(timeoutMs?: number) {
  FakeWorker.instances = [];
  const statuses: Array<[string, StatusTone]> = [];
  let now = 1_000;
  const client = new CompilerClient("worker.js", {
    onStatus: (text, tone) => statuses.push([text, tone]),
    createWorker: (url) => new FakeWorker(url),
    now: () => now,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return {
    client,
    statuses,
    advance: (ms: number) => {
      now += ms;
    },
    worker: () => FakeWorker.instances.at(-1) as FakeWorker,
  };
}

describe("the compiler client", () => {
  test("warms once, reports the version and the load time, and compiles through the worker", async () => {
    const h = harness();
    const ready = h.client.warm();
    expect(h.client.warm()).toBe(ready);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(h.worker().url).toBe("worker.js");
    expect(h.statuses).toEqual([["compiler: loading…", "wait"]]);
    h.advance(1_500);
    h.worker().reply({ type: "ready", version: "0.28.20" });
    expect(await ready).toBe("0.28.20");
    expect(h.client.loadMs).toBe(1_500);
    expect(h.statuses.at(-1)).toEqual(["compiler 0.28.20 ready in 1.5 s", "live"]);
    const result = h.client.compile("export function run(): void {}");
    await Promise.resolve();
    const req = h.worker().posted[0];
    expect(req?.type).toBe("compile");
    expect(req?.fs.entry).toBe(ENTRY);
    expect(req?.fs.files[ENTRY]).toBe("export function run(): void {}");
    expect(req?.flags).toContain("-O3");
    h.worker().reply(compiled(req?.id ?? 0));
    expect((await result).ok).toBe(true);
    expect((await result).ms).toBe(7);
  });

  test("a compile the worker never answers is failed at the timeout and the worker replaced", async () => {
    const h = harness(5);
    const ready = h.client.warm();
    h.worker().reply({ type: "ready", version: "x" });
    await ready;
    const first = h.worker();
    await expect(h.client.compile("a")).rejects.toThrow("did not answer");
    expect(first.terminated).toBe(true);
    // The next compile starts a fresh worker.
    const again = h.client.compile("b");
    await Promise.resolve();
    expect(FakeWorker.instances).toHaveLength(2);
    h.worker().reply({ type: "ready", version: "x" });
    await ready.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1));
    const req = h.worker().posted[0];
    expect(req).toBeDefined();
    h.worker().reply(compiled(req?.id ?? 0));
    expect((await again).ok).toBe(true);
  });

  test("a dead worker answers every compile it owed and is replaced on the next warm", async () => {
    const h = harness();
    const ready = h.client.warm();
    h.worker().reply({ type: "ready", version: "x" });
    await ready;
    const pending = h.client.compile("a");
    await Promise.resolve();
    h.worker().die("boom");
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe("boom");
    expect(h.statuses.at(-1)).toEqual(["compiler failed: boom", "off"]);
    expect(h.worker().terminated).toBe(true);
    const next = h.client.warm();
    expect(FakeWorker.instances).toHaveLength(2);
    h.worker().reply({ type: "ready", version: "y" });
    expect(await next).toBe("y");
  });

  test("a worker that dies while loading rejects the warm-up with its message", async () => {
    const h = harness();
    const ready = h.client.warm();
    h.worker().die("");
    await expect(ready).rejects.toThrow("worker error");
  });
});
