import { describe, expect, test } from "bun:test";
import { decodeStageSpec } from "@tabframe/protocol";
import { runTask } from "../src/run.ts";
import type { TaskResult } from "../src/types.ts";
import { compileFixture } from "./compile.ts";
import { dec, enc, limits, MapReader, manifest, modeInput } from "./helpers.ts";

async function mod(name: string): Promise<WebAssembly.Module> {
  return new WebAssembly.Module(await compileFixture(name, { maximumMemory: 256 }));
}

function run(
  module: WebAssembly.Module,
  input: Uint8Array,
  kind: "run" | "plan" = "run",
  lim = limits,
): TaskResult {
  return runTask(module, { kind, input, manifest, limits: lim, reader: new MapReader() });
}

const text = (r: TaskResult): string => (r.ok ? dec.decode(r.output) : `ERR ${r.error}`);

describe("runTask", () => {
  test("echo: run returns its input, plan returns a done spec", async () => {
    const m = await mod("echo");
    const r = run(m, enc.encode("ping"));
    expect(text(r)).toBe("ping");
    expect(r.ok && r.computeMs).toBeGreaterThanOrEqual(0);
    const p = run(m, new Uint8Array(0), "plan");
    expect(p.ok).toBe(true);
    if (p.ok) expect(decodeStageSpec(p.output)).toEqual({ kind: "done", next: null });
  });

  test("every task gets a fresh instance: a global counter never persists", async () => {
    const m = await mod("counter");
    for (let i = 0; i < 3; i++) {
      const r = run(m, new Uint8Array(0));
      expect(r.ok && new DataView(r.output.buffer).getInt32(0, true)).toBe(1);
    }
  });

  test("abort carries the program's message; unreachable is a trap", async () => {
    const m = await mod("trap");
    expect(text(run(m, new Uint8Array([0])))).toMatch(/^ERR abort: boom/);
    expect(text(run(m, new Uint8Array([1])))).toMatch(/^ERR trap: /);
  });

  test("the output cap is enforced", async () => {
    const m = await mod("echo");
    const r = run(m, enc.encode("0123456789"), "run", { ...limits, maxOutputBytes: 4 });
    expect(text(r)).toMatch(/^ERR output is 10 bytes, cap 4/);
  });

  test("a module missing the entry point fails cleanly", async () => {
    const m = new WebAssembly.Module(await compileFixture("noplan", { maximumMemory: 256 }));
    expect(text(run(m, new Uint8Array(0), "plan"))).toBe("ERR missing export plan");
  });
});

describe("the tf imports through a real program", () => {
  test("stat, read, list, write, log", async () => {
    const m = await mod("fs");
    const r = run(m, modeInput(0));
    expect(text(r)).toBe("size=11;list=/in/a.txt\n/in/b.txt;data=hello world;rc=0");
    expect(r.ok && dec.decode(r.writes.get("/out/copy.txt"))).toBe("hello world");
    expect(r.ok && r.log).toBe("hello world");
  });
  test("write caps: files and bytes", async () => {
    const m = await mod("fs");
    expect(text(run(m, modeInput(1, 10)))).toBe("rc=-3");
    expect(text(run(m, modeInput(1, 8)))).toBe("rc=0");
    expect(text(run(m, modeInput(2, limits.maxWriteBytes + 1)))).toBe("rc=-3");
    expect(text(run(m, modeInput(2, 16)))).toBe("rc=0");
  });
  test("log cap truncates", async () => {
    const m = await mod("fs");
    const r = run(m, modeInput(3, 10));
    expect(text(r)).toBe("ok");
    expect(r.ok && r.log.endsWith("[log truncated]")).toBe(true);
    expect(r.ok && r.log.length).toBeLessThan(100);
  });
  test("unknown paths, bad paths, bad arguments", async () => {
    const m = await mod("fs");
    expect(text(run(m, modeInput(4)))).toBe("stat=-1;read=-1");
    expect(text(run(m, modeInput(5)))).toBe("rc=-2");
    expect(text(run(m, modeInput(9)))).toBe("rc=-2");
  });
  test("list reports the bytes needed when the buffer is too small", async () => {
    const m = await mod("fs");
    expect(text(run(m, modeInput(6)))).toBe("need19|/in/a.txt\n/in/b.txt");
  });
  test("read at an offset and own writes shadowing", async () => {
    const m = await mod("fs");
    expect(text(run(m, modeInput(7)))).toBe("n=3;llo");
    expect(text(run(m, modeInput(8)))).toBe("own=mine;stat=4;list=/out/own.txt");
  });
  test("determinism: the same input and filesystem yield identical bytes", async () => {
    const m = await mod("fs");
    const a = run(m, modeInput(0));
    const b = run(m, modeInput(0));
    expect(a.ok && b.ok && a.output).toEqual(b.ok ? b.output : new Uint8Array());
  });
});
