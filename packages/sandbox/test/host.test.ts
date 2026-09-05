import { describe, expect, test } from "bun:test";
import { serveTasks } from "../src/adapters/serve.ts";
import { wrapBrowserWorker } from "../src/adapters/web-host.ts";
import {
  createSandboxHost,
  type ResultMessage,
  type TaskMessage,
  type WorkerLike,
} from "../src/host.ts";
import { runTask } from "../src/run.ts";
import type { HostRequest } from "../src/types.ts";
import { compileFixture } from "./compile.ts";
import { dec, enc, limits, MapReader, manifest } from "./helpers.ts";

/** A worker that runs tasks in-process, or hangs, or crashes, or chats. */
class FakeWorker implements WorkerLike {
  static spawned = 0;
  terminated = false;
  /** The store base of the last task message, as the web worker would read it. */
  storeBase: string | undefined;
  private handler: ((msg: unknown) => void) | null = null;
  private errorHandler: ((err: unknown) => void) | null = null;
  private readonly behavior: "run" | "hang" | "crash" | "chatty";
  constructor(behavior: "run" | "hang" | "crash" | "chatty") {
    this.behavior = behavior;
    FakeWorker.spawned++;
  }
  postMessage(msg: unknown): void {
    const m = msg as TaskMessage;
    if (m.type !== "task") return;
    this.storeBase = m.storeBase;
    if (this.behavior === "hang") return;
    if (this.behavior === "crash") {
      queueMicrotask(() => this.errorHandler?.(new Error("kaboom")));
      return;
    }
    if (this.behavior === "chatty")
      queueMicrotask(() => this.handler?.({ type: "blob", hash: "x" }));
    const result = runTask(m.module, { ...m.request, reader: new MapReader() });
    queueMicrotask(() => this.handler?.({ type: "result", id: m.id, result }));
  }
  terminate(): void {
    this.terminated = true;
  }
  onMessage(handler: (msg: unknown) => void): void {
    this.handler = handler;
  }
  onError(handler: (err: unknown) => void): void {
    this.errorHandler = handler;
  }
}

const request = (input: string): HostRequest => ({
  kind: "run",
  input: enc.encode(input),
  manifest,
  limits,
});

describe("createSandboxHost", () => {
  test("runs tasks through the worker, serialized, reusing one worker", async () => {
    const m = new WebAssembly.Module(await compileFixture("echo"));
    FakeWorker.spawned = 0;
    const host = createSandboxHost(() => new FakeWorker("run"));
    const [a, b] = await Promise.all([
      host.run(m, request("one"), 1000),
      host.run(m, request("two"), 1000),
    ]);
    expect(a.ok && dec.decode(a.output)).toBe("one");
    expect(b.ok && dec.decode(b.output)).toBe("two");
    expect(FakeWorker.spawned).toBe(1);
    host.dispose();
  });

  test("a deadline terminates the worker and the next task gets a fresh one", async () => {
    const m = new WebAssembly.Module(await compileFixture("echo"));
    const workers: FakeWorker[] = [];
    let behavior: "run" | "hang" = "hang";
    const host = createSandboxHost(() => {
      const w = new FakeWorker(behavior);
      workers.push(w);
      return w;
    });
    const r = await host.run(m, request("slow"), 30);
    expect(r).toEqual({ ok: false, error: "deadline", log: "" });
    expect(workers[0]?.terminated).toBe(true);
    behavior = "run";
    const ok = await host.run(m, request("again"), 1000);
    expect(ok.ok && dec.decode(ok.output)).toBe("again");
    expect(workers.length).toBe(2);
  });

  test("a worker crash fails the task and is replaced; other messages reach onOther; the store base rides along", async () => {
    const m = new WebAssembly.Module(await compileFixture("echo"));
    const others: unknown[] = [];
    const workers: FakeWorker[] = [];
    let behavior: "crash" | "chatty" = "crash";
    const host = createSandboxHost(
      () => {
        const w = new FakeWorker(behavior);
        workers.push(w);
        return w;
      },
      { onOther: (msg) => others.push(msg), storeBase: "http://s/blob" },
    );
    const r = await host.run(m, request("x"), 1000);
    expect(!r.ok && r.error).toBe("worker error: kaboom");
    behavior = "chatty";
    const ok = await host.run(m, request("y"), 1000);
    expect(ok.ok).toBe(true);
    expect(others).toEqual([{ type: "blob", hash: "x" }]);
    expect(workers.map((w) => w.storeBase)).toEqual(["http://s/blob", "http://s/blob"]);
  });

  test("without a store base the task message carries none", async () => {
    const m = new WebAssembly.Module(await compileFixture("echo"));
    const w = new FakeWorker("run");
    const host = createSandboxHost(() => w);
    await host.run(m, request("x"), 1000);
    expect(w.storeBase).toBeUndefined();
  });

  test("dispose settles a pending task", async () => {
    const m = new WebAssembly.Module(await compileFixture("echo"));
    const host = createSandboxHost(() => new FakeWorker("hang"));
    const p = host.run(m, request("x"), 10_000);
    host.dispose();
    expect(!(await p).ok).toBe(true);
  });

  test("wrapBrowserWorker maps the browser worker surface", () => {
    const sent: unknown[] = [];
    const browser = {
      postMessage: (m: unknown) => sent.push(m),
      terminate: () => sent.push("terminated"),
      onmessage: null as ((ev: { data: unknown }) => void) | null,
      onerror: null as ((ev: unknown) => void) | null,
    };
    const w = wrapBrowserWorker(browser);
    const got: unknown[] = [];
    w.onMessage((m) => got.push(m));
    w.onError((e) => got.push(`err:${String(e)}`));
    w.postMessage({ hi: 1 });
    browser.onmessage?.({ data: { reply: 2 } });
    browser.onerror?.("bad");
    w.terminate();
    expect(sent).toEqual([{ hi: 1 }, "terminated"]);
    expect(got).toEqual([{ reply: 2 }, "err:bad"]);
  });
});

describe("serveTasks", () => {
  test("runs task messages with the reader chosen for them and ignores everything else", async () => {
    const m = new WebAssembly.Module(await compileFixture("echo"));
    const replies: ResultMessage[] = [];
    const bases: Array<string | undefined> = [];
    const serve = serveTasks(
      (msg) => {
        bases.push(msg.storeBase);
        return new MapReader();
      },
      (reply) => replies.push(reply),
    );
    serve(null);
    serve({ type: "blob", hash: "x" });
    serve({ type: "task", id: 7, module: m, request: request("hi"), storeBase: "/blob" });
    serve({ type: "task", id: 8, module: m, request: request("there") });
    expect(replies.map((r) => [r.id, r.result.ok && dec.decode(r.result.output)])).toEqual([
      [7, "hi"],
      [8, "there"],
    ]);
    expect(bases).toEqual(["/blob", undefined]);
  });
});
