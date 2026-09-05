// Generators and boundary cases for the ABI's property tests. Test-only: not exported from the
// package. The random generators reach every kind of value the formats carry; the boundary cases
// sit exactly at each cap and one past it, where a decoder must accept and must refuse.
import fc from "fast-check";
import type { Bar } from "./abi-bars.ts";
import type { StageSpec, TaskSpec } from "./abi-spec.ts";
import { byteLength } from "./canonical.ts";
import { BARS_LIMITS, SPEC_LIMITS, type SpecLimits } from "./limits.ts";

/** Well-formed text with every JSON escape and some non-ASCII. */
export const arbText: fc.Arbitrary<string> = fc
  .array(
    fc.oneof(
      fc.string({ unit: "grapheme", maxLength: 12 }),
      fc.constantFrom('"', "\\", "\n", "\r", "\t", "\b", "\f", "\u0001", "/", "é", "🐋"),
    ),
    { maxLength: 8 },
  )
  .map((parts) => parts.join(""));

/** Tables with unicode keys and nested, null, float, and string values, as JSON carries them. */
export const arbTable: fc.Arbitrary<Record<string, unknown>> = fc
  .dictionary(arbText, fc.jsonValue({ maxDepth: 3 }), { maxKeys: 12 })
  .map((t) => JSON.parse(JSON.stringify(t)) as Record<string, unknown>);

const arbPlace = fc.record({
  x: fc.integer({ min: -100, max: 100 }),
  y: fc.integer({ min: -100, max: 100 }),
  w: fc.integer({ min: 1, max: SPEC_LIMITS.maxPlaceSide }),
  h: fc.integer({ min: 1, max: SPEC_LIMITS.maxPlaceSide }),
});

const arbTask: fc.Arbitrary<TaskSpec> = fc
  .tuple(fc.uint8Array({ maxLength: 64 }), fc.option(arbPlace, { nil: null }))
  .map(([input, place]) => (place ? { input, place } : { input }));

/** A canvas within both the side cap and the pixel cap. */
const arbCanvas = fc.integer({ min: 1, max: SPEC_LIMITS.maxCanvasSide }).chain((w) =>
  fc.record({
    w: fc.constant(w),
    h: fc.integer({
      min: 1,
      max: Math.min(SPEC_LIMITS.maxCanvasSide, Math.floor(SPEC_LIMITS.maxCanvasPixels / w)),
    }),
  }),
);

const arbName = arbText.filter((s) => s.length > 0 && byteLength(s) <= SPEC_LIMITS.maxNameBytes);

/** Any valid stage spec: unicode names, canvases up to the caps, placed and unplaced tasks, or done. */
export const arbStageSpec: fc.Arbitrary<StageSpec> = fc.oneof(
  fc
    .tuple(
      arbName,
      fc.option(arbCanvas, { nil: null }),
      fc.array(arbTask, { minLength: 1, maxLength: 20 }),
    )
    .map(
      ([name, canvas, tasks]): StageSpec =>
        canvas ? { kind: "stage", name, canvas, tasks } : { kind: "stage", name, tasks },
    ),
  fc.option(arbTable, { nil: null }).map((next): StageSpec => ({ kind: "done", next })),
);

/** Any valid bars payload: unicode labels within the byte cap, finite values. */
export const arbBars: fc.Arbitrary<Bar[]> = fc.array(
  fc.record({
    label: arbText.filter((s) => byteLength(s) <= BARS_LIMITS.maxLabelBytes),
    value: fc.double({ noNaN: true, noDefaultInfinity: true }),
  }),
  { maxLength: 50 },
);

export interface SpecBoundary {
  name: string;
  spec: StageSpec;
  /** Whether the decoder must accept it. */
  ok: boolean;
  /** Limits to decode with when the case would not fit under the default byte cap. */
  limits?: SpecLimits;
}

const tasks = (n: number, input = new Uint8Array(0)): TaskSpec[] =>
  Array.from({ length: n }, () => ({ input }));
const stage = (name: string, t: TaskSpec[], canvas?: { w: number; h: number }): StageSpec =>
  canvas ? { kind: "stage", name, canvas, tasks: t } : { kind: "stage", name, tasks: t };
const table = (n: number): Record<string, unknown> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));

/** Every stage spec cap at its value and one past it. */
export function specBoundaries(): SpecBoundary[] {
  const L = SPEC_LIMITS;
  const roomy = { ...L, maxBytes: 1 << 26 };
  const square = { w: L.maxCanvasSide, h: L.maxCanvasPixels / L.maxCanvasSide };
  return [
    { name: "maxTasks tasks", spec: stage("x", tasks(L.maxTasks)), ok: true },
    {
      name: "maxTasks + 1 tasks",
      spec: stage("x", tasks(L.maxTasks + 1)),
      ok: false,
      limits: roomy,
    },
    {
      name: "an input of maxInlineInput bytes",
      spec: stage("x", tasks(1, new Uint8Array(L.maxInlineInput))),
      ok: true,
    },
    {
      name: "an input one byte over",
      spec: stage("x", tasks(1, new Uint8Array(L.maxInlineInput + 1))),
      ok: false,
    },
    { name: "a name of maxNameBytes", spec: stage("n".repeat(L.maxNameBytes), tasks(1)), ok: true },
    {
      name: "a name one byte over",
      spec: stage("n".repeat(L.maxNameBytes + 1), tasks(1)),
      ok: false,
    },
    { name: "a canvas at the side and pixel caps", spec: stage("x", tasks(1), square), ok: true },
    {
      name: "a canvas one row over the pixel cap",
      spec: stage("x", tasks(1), { w: square.w, h: square.h + 1 }),
      ok: false,
    },
    {
      name: "a canvas one column over the side cap",
      spec: stage("x", tasks(1), { w: L.maxCanvasSide + 1, h: 1 }),
      ok: false,
    },
    {
      name: "a placement of maxPlaceSide",
      spec: stage("x", [
        { input: new Uint8Array(0), place: { x: 0, y: 0, w: L.maxPlaceSide, h: L.maxPlaceSide } },
      ]),
      ok: true,
    },
    {
      name: "a placement one over",
      spec: stage("x", [
        { input: new Uint8Array(0), place: { x: 0, y: 0, w: L.maxPlaceSide + 1, h: 1 } },
      ]),
      ok: false,
    },
    {
      name: "a done table of maxTableEntries",
      spec: { kind: "done", next: table(L.maxTableEntries) },
      ok: true,
    },
    {
      name: "a done table one entry over",
      spec: { kind: "done", next: table(L.maxTableEntries + 1) },
      ok: false,
    },
  ];
}

export interface BarsBoundary {
  name: string;
  bars: Bar[];
  ok: boolean;
}

/** Every bars cap at its value and one past it. */
export function barsBoundaries(): BarsBoundary[] {
  const L = BARS_LIMITS;
  const bars = (n: number, label = "a"): Bar[] =>
    Array.from({ length: n }, () => ({ label, value: 1 }));
  return [
    { name: "maxBars bars", bars: bars(L.maxBars), ok: true },
    { name: "maxBars + 1 bars", bars: bars(L.maxBars + 1), ok: false },
    { name: "a label of maxLabelBytes", bars: bars(1, "l".repeat(L.maxLabelBytes)), ok: true },
    { name: "a label one byte over", bars: bars(1, "l".repeat(L.maxLabelBytes + 1)), ok: false },
  ];
}
