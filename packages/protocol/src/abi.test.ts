import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  AbiError,
  type Bar,
  decodeBars,
  decodePlanInput,
  decodeRunInput,
  decodeStageSpec,
  encodeBars,
  encodePlanInput,
  encodeRunInput,
  encodeStageSpec,
  type StageSpec,
  type TaskSpec,
} from "./abi.ts";
import { BARS_LIMITS, SPEC_LIMITS } from "./limits.ts";

const bytes = (...b: number[]) => new Uint8Array(b);

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
  test("structural caps: task count, input size, name, placement, canvas, trailing bytes", () => {
    const many: StageSpec = {
      kind: "stage",
      name: "x",
      tasks: Array.from({ length: SPEC_LIMITS.maxTasks + 1 }, () => ({ input: bytes() })),
    };
    expect(() =>
      decodeStageSpec(encodeStageSpec(many), { ...SPEC_LIMITS, maxBytes: 1 << 26 }),
    ).toThrow(/task count/);
    const big: StageSpec = {
      kind: "stage",
      name: "x",
      tasks: [{ input: new Uint8Array(SPEC_LIMITS.maxInlineInput + 1) }],
    };
    expect(() => decodeStageSpec(encodeStageSpec(big))).toThrow(/input exceeds/);
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
  test("any valid spec survives a round trip (property)", () => {
    const arbPlace = fc.record({
      x: fc.integer({ min: -100, max: 100 }),
      y: fc.integer({ min: -100, max: 100 }),
      w: fc.integer({ min: 1, max: 256 }),
      h: fc.integer({ min: 1, max: 256 }),
    });
    const arbTask: fc.Arbitrary<TaskSpec> = fc
      .tuple(fc.uint8Array({ maxLength: 64 }), fc.option(arbPlace, { nil: null }))
      .map(([input, place]) => (place ? { input, place } : { input }));
    const arbCanvas = fc.option(
      // Within the WP8.3 cap: 4096 a side and four megapixels in all.
      fc.record({ w: fc.integer({ min: 1, max: 2048 }), h: fc.integer({ min: 1, max: 2048 }) }),
      { nil: null },
    );
    const arbStage: fc.Arbitrary<StageSpec> = fc
      .tuple(
        fc.stringMatching(/^[a-z]{1,10}$/),
        arbCanvas,
        fc.array(arbTask, { minLength: 1, maxLength: 20 }),
      )
      .map(([name, canvas, tasks]) =>
        canvas ? { kind: "stage", name, canvas, tasks } : { kind: "stage", name, tasks },
      );
    const arbDone: fc.Arbitrary<StageSpec> = fc
      .option(
        fc.dictionary(
          fc.stringMatching(/^[a-z]{1,8}$/),
          fc.oneof(fc.integer(), fc.string(), fc.boolean()),
        ),
        { nil: null },
      )
      .map((next) => ({ kind: "done", next }));
    fc.assert(
      fc.property(fc.oneof(arbStage, arbDone), (spec: StageSpec) => {
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

  test("caps and validity: count, label bytes, total size, finite values, trailing bytes, magic", () => {
    const one = encodeBars([{ label: "a", value: 1 }]);
    expect(() => decodeBars(one, { ...BARS_LIMITS, maxBars: 0 })).toThrow(AbiError);
    const longLabel = encodeBars([{ label: "x".repeat(BARS_LIMITS.maxLabelBytes + 1), value: 1 }]);
    expect(() => decodeBars(longLabel)).toThrow(/label exceeds/);
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

  test("any list of finite bars survives a round trip (property)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            label: fc.string({ maxLength: 40 }),
            value: fc.double({ noNaN: true, noDefaultInfinity: true }),
          }),
          { maxLength: 50 },
        ),
        (bars) => {
          expect(decodeBars(encodeBars(bars))).toEqual(bars);
        },
      ),
      { numRuns: 100 },
    );
  });
});
