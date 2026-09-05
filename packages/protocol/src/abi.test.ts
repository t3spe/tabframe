import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { arbBars, arbStageSpec, arbTable, barsBoundaries, specBoundaries } from "./arbitraries.ts";
import {
  AbiError,
  BARS_LIMITS,
  type Bar,
  decodeBars,
  decodePlanInput,
  decodeRunInput,
  decodeStageSpec,
  encodeBars,
  encodePlanInput,
  encodeRunInput,
  encodeStageSpec,
  SPEC_LIMITS,
  type StageSpec,
} from "./index.ts";

const bytes = (...b: number[]) => new Uint8Array(b);

/** The code and offset of the AbiError a decode throws. */
function failure(decode: () => unknown): [string, number] {
  try {
    decode();
  } catch (err) {
    if (err instanceof AbiError) return [err.code, err.at];
    throw err;
  }
  throw new Error("decoded");
}

/** "ok" with the value, or "refused" when the decoder threw an AbiError. */
function outcome<T>(decode: () => T): { outcome: "ok" | "refused"; value: T | null } {
  try {
    return { outcome: "ok", value: decode() };
  } catch (err) {
    if (err instanceof AbiError) return { outcome: "refused", value: null };
    throw err;
  }
}

describe("run and plan inputs", () => {
  test("run input round-trips and starts with the magic", () => {
    const enc = encodeRunInput({ stage: 2, taskIndex: 17, taskCount: 640, input: bytes(1, 2, 3) });
    expect(String.fromCharCode(...enc.subarray(0, 4))).toBe("TFRN");
    expect(decodeRunInput(enc)).toEqual({
      stage: 2,
      taskIndex: 17,
      taskCount: 640,
      input: bytes(1, 2, 3),
    });
  });
  test("plan input carries params and hints as sorted tables of JSON text", () => {
    const enc = encodePlanInput({
      stage: 0,
      params: { preset: 3, palette: "fire", nested: { a: [1, 2] } },
      hints: { nodes: 5 },
    });
    const dec = decodePlanInput(enc);
    expect(dec.stage).toBe(0);
    expect(dec.params).toEqual({ preset: 3, palette: "fire", nested: { a: [1, 2] } });
    expect(dec.hints).toEqual({ nodes: 5 });
    // Key order does not change the bytes.
    const other = encodePlanInput({
      stage: 0,
      params: { nested: { a: [1, 2] }, palette: "fire", preset: 3 },
      hints: { nodes: 5 },
    });
    expect(other).toEqual(enc);
  });
  test("wrong magic, wrong version, truncation", () => {
    expect(() => decodeRunInput(encodePlanInput({ stage: 0, params: {}, hints: {} }))).toThrow(
      AbiError,
    );
    const enc = encodeRunInput({ stage: 0, taskIndex: 0, taskCount: 1, input: bytes() });
    enc[4] = 9;
    expect(() => decodeRunInput(enc)).toThrow(/version/);
    expect(() =>
      decodeRunInput(
        encodeRunInput({ stage: 0, taskIndex: 0, taskCount: 1, input: bytes(1, 2) }).subarray(
          0,
          20,
        ),
      ),
    ).toThrow(/truncated/);
  });
  test("run and plan inputs tolerate trailing bytes", () => {
    const run = encodeRunInput({ stage: 1, taskIndex: 2, taskCount: 3, input: bytes(9) });
    expect(decodeRunInput(new Uint8Array([...run, 0, 0])).input).toEqual(bytes(9));
    const plan = encodePlanInput({ stage: 0, params: { a: 1 }, hints: {} });
    expect(decodePlanInput(new Uint8Array([...plan, 7])).params).toEqual({ a: 1 });
  });
  test("property: any tables round-trip through a plan input", () => {
    fc.assert(
      fc.property(arbTable, arbTable, (params, hints) => {
        expect(decodePlanInput(encodePlanInput({ stage: 3, params, hints }))).toEqual({
          stage: 3,
          params,
          hints,
        });
      }),
      { numRuns: 100 },
    );
  });
});

describe("errors", () => {
  test("carry a code and the offset where the check failed; messages unchanged", () => {
    expect(
      failure(() => decodeRunInput(encodePlanInput({ stage: 0, params: {}, hints: {} }))),
    ).toEqual(["magic", 0]);
    const versioned = encodeRunInput({ stage: 0, taskIndex: 0, taskCount: 1, input: bytes() });
    versioned[4] = 9;
    expect(failure(() => decodeRunInput(versioned))).toEqual(["version", 4]);
    const run = encodeRunInput({ stage: 0, taskIndex: 0, taskCount: 1, input: bytes(1, 2) });
    expect(failure(() => decodeRunInput(run.subarray(0, 20)))).toEqual(["truncated", 20]);
    const done = encodeStageSpec({ kind: "done", next: null });
    expect(failure(() => decodeStageSpec(new Uint8Array([...done, 0])))).toEqual(["shape", 10]);
    const empty = encodeStageSpec({ kind: "stage", name: "x", tasks: [] });
    expect(failure(() => decodeStageSpec(empty))).toEqual(["cap", 19]);
    expect(() => decodeStageSpec(empty)).toThrow("task count 0 outside 1..4096");
    const nan = encodeBars([{ label: "nan", value: Number.NaN }]);
    expect(failure(() => decodeBars(nan))).toEqual(["shape", 27]);
    expect(failure(() => decodeStageSpec(new Uint8Array(SPEC_LIMITS.maxBytes + 1)))).toEqual([
      "cap",
      0,
    ]);
  });
});

describe("stage specs", () => {
  const stage: StageSpec = {
    kind: "stage",
    name: "render",
    canvas: { w: 2048, h: 1280 },
    tasks: [{ input: bytes(9, 9), place: { x: 0, y: 0, w: 64, h: 64 } }, { input: bytes() }],
  };
  test("stage round-trips with canvas and placements", () => {
    const enc = encodeStageSpec(stage);
    expect(String.fromCharCode(...enc.subarray(0, 4))).toBe("TFSS");
    expect(decodeStageSpec(enc)).toEqual(stage);
  });
  test("done round-trips with and without follow-up params", () => {
    expect(decodeStageSpec(encodeStageSpec({ kind: "done", next: { preset: 4 } }))).toEqual({
      kind: "done",
      next: { preset: 4 },
    });
    expect(decodeStageSpec(encodeStageSpec({ kind: "done", next: null }))).toEqual({
      kind: "done",
      next: null,
    });
  });
  test("what is refused is named: empty name, zero placement, zero canvas, no tasks, trailing bytes, junk kind", () => {
    expect(() =>
      decodeStageSpec(encodeStageSpec({ kind: "stage", name: "", tasks: [{ input: bytes() }] })),
    ).toThrow(/stage name/);
    expect(() =>
      decodeStageSpec(
        encodeStageSpec({
          kind: "stage",
          name: "x",
          tasks: [{ input: bytes(), place: { x: 0, y: 0, w: 0, h: 1 } }],
        }),
      ),
    ).toThrow(/placement/);
    expect(() =>
      decodeStageSpec(
        encodeStageSpec({
          kind: "stage",
          name: "x",
          canvas: { w: 0, h: 1 },
          tasks: [{ input: bytes() }],
        }),
      ),
    ).toThrow(/canvas/);
    expect(() => decodeStageSpec(encodeStageSpec({ kind: "stage", name: "x", tasks: [] }))).toThrow(
      /task count/,
    );
    const trailing = new Uint8Array([...encodeStageSpec({ kind: "done", next: null }), 0]);
    expect(() => decodeStageSpec(trailing)).toThrow(/trailing/);
    expect(() => decodeStageSpec(new Uint8Array(SPEC_LIMITS.maxBytes + 1))).toThrow(/cap/);
    const junkKind = encodeStageSpec({ kind: "done", next: null });
    junkKind[8] = 7;
    expect(() => decodeStageSpec(junkKind)).toThrow(/unknown spec kind/);
  });
  test("every cap accepts its value and refuses one past it", () => {
    for (const c of specBoundaries()) {
      const r = outcome(() => decodeStageSpec(encodeStageSpec(c.spec), c.limits ?? SPEC_LIMITS));
      expect([c.name, r.outcome]).toEqual([c.name, c.ok ? "ok" : "refused"]);
      if (c.ok) expect(r.value).toEqual(c.spec);
    }
  });
  test("any valid spec survives a round trip (property)", () => {
    fc.assert(
      fc.property(arbStageSpec, (spec) => {
        expect(decodeStageSpec(encodeStageSpec(spec))).toEqual(spec);
      }),
      { numRuns: 150 },
    );
  });
});

describe("bars payloads", () => {
  test("round-trips labels and values and starts with the magic", () => {
    const bars: Bar[] = [
      { label: "the", value: 14535 },
      { label: "ünïcödé", value: -1.5 },
      { label: "", value: 0 },
    ];
    const encoded = encodeBars(bars);
    expect(Array.from(encoded.subarray(0, 4))).toEqual([0x54, 0x46, 0x42, 0x52]); // "TFBR"
    expect(decodeBars(encoded)).toEqual(bars);
    expect(decodeBars(encodeBars([]))).toEqual([]);
  });

  test("what is refused is named: a lower cap, total size, non-finite values, trailing bytes, magic, truncation", () => {
    const one = encodeBars([{ label: "a", value: 1 }]);
    expect(() => decodeBars(one, { ...BARS_LIMITS, maxBars: 0 })).toThrow(AbiError);
    expect(() => decodeBars(one, { ...BARS_LIMITS, maxBytes: 8 })).toThrow(/cap/);
    expect(() => decodeBars(encodeBars([{ label: "nan", value: Number.NaN }]))).toThrow(
      /not finite/,
    );
    expect(() =>
      decodeBars(encodeBars([{ label: "inf", value: Number.POSITIVE_INFINITY }])),
    ).toThrow(/not finite/);
    const trailing = new Uint8Array(one.length + 1);
    trailing.set(one);
    expect(() => decodeBars(trailing)).toThrow(/trailing/);
    expect(() => decodeBars(encodeStageSpec({ kind: "done", next: null }))).toThrow(/not a bars/);
    expect(() => decodeBars(one.subarray(0, one.length - 3))).toThrow(/truncated/);
  });

  test("every cap accepts its value and refuses one past it", () => {
    for (const c of barsBoundaries()) {
      const r = outcome(() => decodeBars(encodeBars(c.bars)));
      expect([c.name, r.outcome]).toEqual([c.name, c.ok ? "ok" : "refused"]);
      if (c.ok) expect(r.value).toEqual(c.bars);
    }
  });

  test("any list of finite bars survives a round trip (property)", () => {
    fc.assert(
      fc.property(arbBars, (bars) => {
        expect(decodeBars(encodeBars(bars))).toEqual(bars);
      }),
      { numRuns: 100 },
    );
  });
});
