import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runTask } from "@tabframe/sandbox";
import { compileProgram } from "../scripts/build-programs.ts";
import { HOST_LIMITS, instantiate, loadProgram, memoryFs, ProgramError } from "../scripts/host.ts";

// The echo program is compiled at test time by the compiler and flags the build uses, so these
// tests prove the SDK's byte formats against @tabframe/protocol in both directions.
const here = import.meta.dir;
const out = path.join(here, "..", "dist-test", "echo.wasm");
let module: WebAssembly.Module;
let wasm: Uint8Array;

beforeAll(async () => {
  await compileProgram(path.join(here, "assembly", "echo.ts"), out);
  wasm = new Uint8Array(readFileSync(out));
  module = loadProgram(wasm).module;
}, 60_000);

describe("run input", () => {
  test("the SDK decodes what the protocol encodes", () => {
    const input = new Uint8Array([1, 2, 3, 250, 255]);
    const echoed = instantiate(module).run(3, 41, 640, input);
    const view = new DataView(echoed.buffer, echoed.byteOffset, echoed.byteLength);
    expect(view.getUint32(0, true)).toBe(3);
    expect(view.getUint32(4, true)).toBe(41);
    expect(view.getUint32(8, true)).toBe(640);
    expect(view.getUint32(12, true)).toBe(5);
    expect(Array.from(echoed.subarray(16))).toEqual([1, 2, 3, 250, 255]);
  });
  test("an empty input is fine", () => {
    const echoed = instantiate(module).run(0, 0, 1, new Uint8Array(0));
    expect(echoed.length).toBe(16);
  });
});

describe("plan input and stage specs", () => {
  test("a stage with canvas and placements decodes on the protocol side", () => {
    const spec = instantiate(module).plan(0, {
      name: "render",
      n: 3,
      cw: 2048,
      ch: 1280,
      placed: true,
      scale: 0.25,
    });
    expect(spec.kind).toBe("stage");
    if (spec.kind !== "stage") return;
    expect(spec.name).toBe("render");
    expect(spec.canvas).toEqual({ w: 2048, h: 1280 });
    expect(spec.tasks.length).toBe(3);
    spec.tasks.forEach((t, i) => {
      // 0 - i rather than -i: the first task's y is +0, and toEqual tells +0 from -0.
      expect(t.place).toEqual({ x: i * 10, y: 0 - i, w: 10, h: 20 });
      const v = new DataView(t.input.buffer, t.input.byteOffset, t.input.byteLength);
      expect(v.getUint32(0, true)).toBe(i);
      expect(v.getFloat64(4, true)).toBe(0.25);
    });
  });
  test("a stage without canvas or placements", () => {
    const spec = instantiate(module).plan(0, { n: 2 });
    expect(spec.kind === "stage" && spec.canvas).toBeUndefined();
    expect(spec.kind === "stage" && spec.tasks.every((t) => t.place === undefined)).toBe(true);
    expect(spec.kind === "stage" && spec.name).toBe("echo");
  });
  test("done echoes every param raw and decodes scalars, quoted numbers, and fallbacks", () => {
    const params = {
      s: 'he said "hi"\n',
      i: 42,
      f: 2.5,
      b: true,
      list: [1, "two"],
      obj: { k: null },
      bad: "not a number",
      q: "12",
    };
    const spec = instantiate(module).plan(2, params);
    expect(spec.kind).toBe("done");
    if (spec.kind !== "done") return;
    const next = spec.next as Record<string, unknown>;
    expect(next.stage).toBe(2);
    expect(next.s).toBe('he said "hi"\n');
    expect(next.i).toBe(42);
    expect(next.f).toBe(2.5);
    expect(next.b).toBe(true);
    expect(next.missing).toBe("fallback");
    expect(next.bad).toBe(7);
    expect(next.list).toEqual([1, "two"]);
    expect(next.obj).toEqual({ k: null });
    expect(next.q).toBe("12");
  });
  test("done with no params", () => {
    const spec = instantiate(module).plan(1, {});
    expect(spec.kind === "done" && spec.next).toEqual({
      stage: 1,
      s: "?",
      i: -1,
      f: -1,
      b: false,
      missing: "fallback",
      bad: 7,
    });
  });
});

describe("filesystem imports", () => {
  test("read, readRange, write, list, stat, log, and hints reach the host", () => {
    const files = new Map<string, Uint8Array>([
      ["/in/a.txt", new TextEncoder().encode("hello")],
      ["/in/z.txt", new Uint8Array(0)],
    ]);
    const inst = instantiate(module, { files });
    inst.plan(0, { fs: true }, { nodes: 5 });
    expect(new TextDecoder().decode(inst.writes.get("/out/b.txt"))).toBe("olleh");
    expect(new TextDecoder().decode(inst.writes.get("/out/range.txt"))).toBe("ell");
    // One task, one log: the SDK's `log` appends no separator, so the three calls run together.
    expect(inst.logs).toEqual(["listing: /in/a.txt,/in/z.txtstat missing: -1hint nodes: 5"]);
  });
});

describe("module shape", () => {
  test("only the allowed imports, the four exports, and a declared memory maximum", () => {
    const { imports, exports, memory } = loadProgram(wasm);
    expect(imports.sort()).toEqual([
      "env.abort",
      "tf.list",
      "tf.log",
      "tf.read",
      "tf.stat",
      "tf.write",
    ]);
    for (const e of ["memory", "alloc", "run", "plan"]) expect(exports).toContain(e);
    expect(memory.max).toBe(256);
  });
  test("a malformed run input aborts in the SDK and comes back as the node's abort error", () => {
    const { manifest, reader } = memoryFs(new Map());
    // Twenty-four zero bytes: long enough to reach the magic check, and not the magic.
    const r = runTask(module, {
      kind: "run",
      input: new Uint8Array(24),
      manifest,
      reader,
      limits: HOST_LIMITS,
    });
    expect(!r.ok && r.error).toMatch(/^abort: not a run input/);
    const short = runTask(module, {
      kind: "run",
      input: new Uint8Array(3),
      manifest,
      reader,
      limits: HOST_LIMITS,
    });
    expect(!short.ok && short.error).toMatch(/^abort: ByteReader: truncated/);
    // Through the host a failed task is a ProgramError, and so is a spec that does not decode.
    expect(() => instantiate(module).plan(0, { n: 0 })).toThrow(ProgramError);
    expect(() => instantiate(module).plan(0, { n: 0 })).toThrow(/invalid stage spec: task count 0/);
  });
});
