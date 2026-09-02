import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { decodeBars, programManifest } from "@tabframe/protocol";
import fc from "fast-check";
import { compileProgram } from "../scripts/build-programs.ts";
import {
  ALLOWED_IMPORTS,
  instantiate,
  loadProgram,
  memoryLimits,
  ProgramError,
  runStaged,
} from "../scripts/host.ts";
import {
  countWords,
  decodeMapOutput,
  decodePairs,
  encodeText,
  merge,
  partitionOf,
  topK,
} from "./wordcount-reference.ts";

// The program is compiled at test time with the build's compiler and flags, like Mandelbrot.
const root = path.resolve(import.meta.dir, "../../..");
const programDir = path.join(root, "programs", "wordcount");
const out = path.join(import.meta.dir, "..", "dist-test", "wordcount.wasm");
const CORPUS = "/in/corpus.txt";
const PARTITIONS = 8;
let module: WebAssembly.Module;
let wasm: Uint8Array;
const manifest = programManifest.parse(
  JSON.parse(readFileSync(path.join(programDir, "manifest.json"), "utf8")),
);

beforeAll(async () => {
  await compileProgram(path.join(programDir, "assembly", "index.ts"), out);
  wasm = new Uint8Array(readFileSync(out));
  module = (await loadProgram(wasm)).module;
}, 60_000);

const files = (text: string | Uint8Array) =>
  new Map([[CORPUS, typeof text === "string" ? encodeText(text) : text]]);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** The bundle's inputs as the control plane seeds them: programs/wordcount/in/<file> → /in/<file>. */
function bundleInputs(): Map<string, Uint8Array> {
  const inDir = path.join(programDir, "in");
  const m = new Map<string, Uint8Array>();
  for (const f of readdirSync(inDir).sort())
    m.set(`/in/${f}`, new Uint8Array(readFileSync(path.join(inDir, f))));
  return m;
}

/** Decode a map task's input: the range and constants the planner wrote. */
function mapInput(b: Uint8Array): {
  start: number;
  end: number;
  total: number;
  partitions: number;
} {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    start: v.getUint32(0, true),
    end: v.getUint32(4, true),
    total: v.getUint32(8, true),
    partitions: v.getUint32(12, true),
  };
}

/** Run stage 0 over a text with `mapTasks` tasks; returns every task's decoded partition sections. */
async function mapAll(text: string | Uint8Array, mapTasks: number) {
  const fs = files(text);
  const spec = (await instantiate(module, { files: fs })).plan(0, { mapTasks });
  if (spec.kind !== "stage") throw new Error("stage expected");
  const outputs: Array<Array<Array<[string, number]>>> = [];
  for (let i = 0; i < spec.tasks.length; i++) {
    const task = spec.tasks[i] as (typeof spec.tasks)[number];
    const inst = await instantiate(module, { files: fs });
    outputs.push(decodeMapOutput(inst.run(0, i, spec.tasks.length, task.input)));
  }
  return { spec, outputs };
}

/** Sum every section of every map output into one map. */
const total = (outputs: Array<Array<Array<[string, number]>>>) => merge(outputs.flat());

describe("module and manifest", () => {
  test("only allowed imports (no clock, no network, no write), the four exports, memory maximum 256, small", async () => {
    const { imports, exports } = await loadProgram(wasm);
    for (const i of imports) expect(ALLOWED_IMPORTS.has(i)).toBe(true);
    expect(imports.sort()).toEqual(["env.abort", "tf.list", "tf.log", "tf.read", "tf.stat"]);
    expect(exports.sort()).toEqual(["alloc", "memory", "plan", "run"]);
    expect(memoryLimits(wasm).max).toBe(256);
    expect(wasm.length).toBeLessThan(64 * 1024);
  });
  test("manifest declares the bars view and the defaults", () => {
    expect(manifest.name).toBe("wordcount");
    expect(manifest.view).toBe("bars");
    expect(manifest.persist).toBe(false);
    expect(manifest.defaultParams).toEqual({ k: 25, mapTasks: 32 });
  });
  test("the bundle carries the corpus and its attribution", () => {
    const inputs = bundleInputs();
    expect([...inputs.keys()]).toEqual(["/in/ATTRIBUTION.txt", CORPUS]);
    const corpus = inputs.get(CORPUS) as Uint8Array;
    expect(corpus.length).toBeGreaterThan(1_000_000);
    expect(new TextDecoder().decode(corpus.subarray(0, 10))).toBe("MOBY-DICK;");
    expect(new TextDecoder().decode(corpus)).not.toContain("Project Gutenberg");
    expect(existsSync(path.join(programDir, "in", "ATTRIBUTION.txt"))).toBe(true);
  });
});

describe("plan", () => {
  const text = "Call me Ishmael. Some years ago--never mind how long precisely--having little";

  test("stage 0: mapTasks contiguous byte ranges covering the corpus once, eight partitions", async () => {
    const planner = await instantiate(module, { files: files(text) });
    const spec = planner.plan(0, manifest.defaultParams);
    expect(spec.kind).toBe("stage");
    if (spec.kind !== "stage") return;
    expect(spec.name).toBe("map");
    expect(spec.tasks.length).toBe(32);
    let expectStart = 0;
    for (const t of spec.tasks) {
      const r = mapInput(t.input);
      expect(r.start).toBe(expectStart);
      expect(r.end).toBeGreaterThanOrEqual(r.start);
      expect(r.total).toBe(text.length);
      expect(r.partitions).toBe(PARTITIONS);
      expect(t.place).toBeUndefined();
      expectStart = r.end;
    }
    expect(expectStart).toBe(text.length);
  });
  test("stages 1 and 2: eight reducers naming their partition and the map count, one merger with k; then done", async () => {
    const planner = await instantiate(module, { files: files(text) });
    const reduce = planner.plan(1, { k: 7, mapTasks: 5 });
    if (reduce.kind !== "stage") throw new Error("stage expected");
    expect(reduce.name).toBe("reduce");
    expect(reduce.tasks.length).toBe(PARTITIONS);
    reduce.tasks.forEach((t, p) => {
      const v = new DataView(t.input.buffer, t.input.byteOffset);
      expect(v.getUint32(0, true)).toBe(p);
      expect(v.getUint32(4, true)).toBe(5);
    });
    const mergeSpec = planner.plan(2, { k: 7, mapTasks: 5 });
    if (mergeSpec.kind !== "stage") throw new Error("stage expected");
    expect(mergeSpec.name).toBe("merge");
    expect(mergeSpec.tasks.length).toBe(1);
    const v = new DataView((mergeSpec.tasks[0] as { input: Uint8Array }).input.buffer);
    expect(v.getUint32(0, true)).toBe(7);
    expect(v.getUint32(4, true)).toBe(PARTITIONS);
    expect(planner.plan(3, manifest.defaultParams)).toEqual({ kind: "done", next: null });
  });
  test("params are clamped: at least one map task, at most 4096; k between 1 and 4096; junk falls back", async () => {
    const planner = await instantiate(module, { files: files(text) });
    const none = planner.plan(0, { mapTasks: 0 });
    expect(none.kind === "stage" && none.tasks.length).toBe(1);
    const many = planner.plan(0, { mapTasks: 100_000 });
    expect(many.kind === "stage" && many.tasks.length).toBe(4096);
    const junk = planner.plan(0, { mapTasks: "lots" });
    expect(junk.kind === "stage" && junk.tasks.length).toBe(32);
    const k = planner.plan(2, { k: -4 });
    if (k.kind !== "stage") throw new Error("stage expected");
    expect(
      new DataView((k.tasks[0] as { input: Uint8Array }).input.buffer).getUint32(0, true),
    ).toBe(1);
  });
  test("a missing corpus is a program fault at plan time", async () => {
    const planner = await instantiate(module, { files: new Map() });
    expect(() => planner.plan(0, manifest.defaultParams)).toThrow(ProgramError);
    expect(() => planner.plan(0, manifest.defaultParams)).toThrow(/missing \/in\/corpus.txt/);
  });
});

describe("map: the word rule and range ownership", () => {
  test("the reference and the program agree on a text with every kind of separator", async () => {
    const text =
      "Call me Ishmael. 'Tis Ahab's whale--the WHALE! don't; ''; abc123def O'Neil's 3rd, café naïve\nend";
    const { outputs } = await mapAll(text, 1);
    const got = total(outputs);
    expect(got).toEqual(countWords(encodeText(text)));
    expect(got.get("tis")).toBe(1); // leading apostrophe stripped
    expect(got.get("ahab's")).toBe(1); // internal apostrophe kept
    expect(got.get("whale")).toBe(2); // lowercased
    expect(got.get("don't")).toBe(1);
    expect(got.get("abc")).toBe(1); // digits separate
    expect(got.get("def")).toBe(1);
    expect(got.get("o'neil's")).toBe(1);
    expect(got.get("rd")).toBe(1);
    expect(got.get("caf")).toBe(1); // non-ASCII bytes separate (the real corpus is normalized)
    expect(got.get("na")).toBe(1);
    expect(got.get("ve")).toBe(1);
    expect(got.get("end")).toBe(1); // no trailing newline
    expect(got.has("")).toBe(false); // "''" is not a word
  });

  test("a boundary inside a word: the task where the word starts owns it, once", async () => {
    // "hello world": 11 bytes, two tasks split at byte 5 → task 0 owns "hello", task 1 owns "world"
    const { spec, outputs } = await mapAll("hello world", 2);
    if (spec.kind !== "stage") throw new Error("stage expected");
    expect(mapInput((spec.tasks[0] as { input: Uint8Array }).input)).toMatchObject({
      start: 0,
      end: 5,
    });
    expect(total([outputs[0] as Array<Array<[string, number]>>])).toEqual(new Map([["hello", 1]]));
    expect(total([outputs[1] as Array<Array<[string, number]>>])).toEqual(new Map([["world", 1]]));
    // Split at 3 instead: "hel|lo world" → task 0 finishes "hello" past its end, task 1 skips "lo".
    const three = await mapAll("hello world", 4); // ranges [0,2) [2,5) [5,8) [8,11)
    const counts = three.outputs.map((o) => total([o]));
    expect(counts[0]).toEqual(new Map([["hello", 1]]));
    expect(counts[1]).toEqual(new Map()); // entirely inside a word owned by task 0
    expect(counts[2]).toEqual(new Map([["world", 1]]));
    expect(counts[3]).toEqual(new Map());
  });

  test("empty ranges are legal and count nothing; sections keep the header shape", async () => {
    const { spec, outputs } = await mapAll("ab", 5); // more tasks than bytes → empty ranges
    if (spec.kind !== "stage") throw new Error("stage expected");
    const empties = spec.tasks.filter((t) => {
      const r = mapInput(t.input);
      return r.start === r.end;
    });
    expect(empties.length).toBeGreaterThan(0);
    for (const o of outputs) expect(o.length).toBe(PARTITIONS);
    expect(total(outputs)).toEqual(new Map([["ab", 1]]));
  });

  test("a word longer than the tail chunk is finished by reading in chunks", async () => {
    const long = "x".repeat(10_000);
    const text = `start ${long} end`;
    const { outputs } = await mapAll(text, 3); // the long word straddles every boundary
    expect(total(outputs)).toEqual(
      new Map([
        ["start", 1],
        [long, 1],
        ["end", 1],
      ]),
    );
    // And a range that lies entirely inside the long word owns nothing.
    const { outputs: many } = await mapAll(text, 40);
    expect(total(many)).toEqual(
      new Map([
        ["start", 1],
        [long, 1],
        ["end", 1],
      ]),
    );
  });

  test("words land in their FNV-1a partition and every section is sorted by word", async () => {
    const text = readFileSync(path.join(programDir, "in", "corpus.txt")).subarray(0, 20_000);
    const { outputs } = await mapAll(text, 3);
    for (const sections of outputs) {
      sections.forEach((section, p) => {
        for (let i = 0; i < section.length; i++) {
          const [word, count] = section[i] as [string, number];
          expect(partitionOf(word, PARTITIONS)).toBe(p);
          expect(count).toBeGreaterThan(0);
          if (i > 0) expect((section[i - 1] as [string, number])[0] < word).toBe(true);
        }
      });
    }
    expect(total(outputs)).toEqual(countWords(text));
  });

  test("property: for any text and any split, the union of the map outputs is the single-pass count", async () => {
    const separator = fc.constantFrom(" ", "\n", ", ", ". ", "--", "1", "é", "''", "  ");
    const word = fc.stringMatching(/^[a-zA-Z']{1,12}$/);
    const piece = fc.oneof(
      { weight: 5, arbitrary: word },
      { weight: 3, arbitrary: separator },
      {
        weight: 1,
        arbitrary: fc.constant("w".repeat(5000)),
      },
    );
    const textArb = fc.array(piece, { maxLength: 60 }).map((parts) => parts.join(""));
    await fc.assert(
      fc.asyncProperty(textArb, fc.integer({ min: 1, max: 9 }), async (text, mapTasks) => {
        const { outputs } = await mapAll(text, mapTasks);
        expect(total(outputs)).toEqual(countWords(encodeText(text)));
      }),
      { numRuns: 40 },
    );
  }, 120_000);
});

describe("reduce and merge", () => {
  const text = readFileSync(path.join(programDir, "in", "corpus.txt")).subarray(0, 60_000);
  const reference = countWords(text);

  test("reducers own disjoint partitions, sorted by count then word; the merge is the exact top-K", async () => {
    const run = await runStaged(module, files(text), { k: 12, mapTasks: 7 });
    expect(run.stages.map((s) => [s.name, s.taskCount])).toEqual([
      ["map", 7],
      ["reduce", PARTITIONS],
      ["merge", 1],
    ]);
    expect(run.followUp).toBeNull();
    const reduce = run.stages[1] as (typeof run.stages)[number];
    const seen = new Map<string, number>();
    reduce.outputs.forEach((bytes, p) => {
      const pairs = decodePairs(bytes);
      for (let i = 0; i < pairs.length; i++) {
        const [word, count] = pairs[i] as [string, number];
        expect(partitionOf(word, PARTITIONS)).toBe(p);
        expect(seen.has(word)).toBe(false);
        seen.set(word, count);
        if (i > 0) {
          const [pw, pc] = pairs[i - 1] as [string, number];
          expect(pc > count || (pc === count && pw < word)).toBe(true);
        }
      }
    });
    expect(seen).toEqual(reference);
    expect(run.final).not.toBeNull();
    const bars = decodeBars(run.final as Uint8Array).map((b) => [b.label, b.value]);
    expect(bars).toEqual(topK(reference, 12));
    const mergeLog = (run.stages[2] as (typeof run.stages)[number]).logs[0] as string[];
    expect(mergeLog.join(" ")).toContain(`${reference.size} distinct words`);
    // Files as the control plane would fold them.
    expect(run.files.has("/out/0/6")).toBe(true);
    expect(run.files.has("/out/1/7")).toBe(true);
    expect(run.files.has("/out/2/0")).toBe(true);
  });

  test("the same execution twice is byte for byte the same", async () => {
    const a = await runStaged(module, files(text), { k: 5, mapTasks: 3 });
    const b = await runStaged(module, files(text), { k: 5, mapTasks: 3 });
    expect(a.stages.map((s) => s.hashes)).toEqual(b.stages.map((s) => s.hashes));
    expect(sha(a.final as Uint8Array)).toBe(sha(b.final as Uint8Array));
  });

  test("the split does not change the answer", async () => {
    const one = await runStaged(module, files(text), { k: 10, mapTasks: 1 });
    const many = await runStaged(module, files(text), { k: 10, mapTasks: 23 });
    expect(sha(one.final as Uint8Array)).toBe(sha(many.final as Uint8Array));
    // Reduce outputs are identical too: partition sums do not depend on the map split.
    expect((one.stages[1] as { hashes: string[] }).hashes).toEqual(
      (many.stages[1] as { hashes: string[] }).hashes,
    );
  });
});

describe("goldens", () => {
  const goldens = JSON.parse(readFileSync(path.join(programDir, "goldens.json"), "utf8")) as {
    params: Record<string, unknown>;
    stages: Array<{ name: string; taskCount: number; hashes: string[] }>;
    final: { hash: string; bars: Array<{ label: string; value: number }> } | null;
    followUp: unknown;
  };

  test("the whole corpus, single-threaded, matches goldens.json stage for stage", async () => {
    expect(goldens.params).toEqual(manifest.defaultParams);
    const run = await runStaged(module, bundleInputs(), manifest.defaultParams);
    expect(
      run.stages.map((s) => ({ name: s.name, taskCount: s.taskCount, hashes: s.hashes })),
    ).toEqual(goldens.stages);
    expect(sha(run.final as Uint8Array)).toBe(goldens.final?.hash as string);
    expect(run.followUp).toBeNull();
    expect(goldens.followUp).toBeNull();
  }, 60_000);

  test("the goldens' top-25 is what a plain JavaScript count of the corpus says", () => {
    const corpus = bundleInputs().get(CORPUS) as Uint8Array;
    const reference = countWords(corpus);
    expect(goldens.final?.bars).toEqual(
      topK(reference, 25).map(([label, value]) => ({ label, value })),
    );
    const [first, second] = goldens.final?.bars ?? [];
    expect(first?.label).toBe("the");
    expect(second?.label).toBe("of");
    expect(goldens.final?.bars.length).toBe(25);
    // The corpus is the novel, not the ebook: no editorial apparatus survives the stripping.
    expect(new TextDecoder().decode(corpus)).not.toContain("Transcriber");
  });
});
