// What `plan` returns (design §5.2, §5.3):
//
//   "TFSS" u32 version=1 | u8 kind (0 = stage, 1 = done)
//   stage : str name | u8 hasCanvas [u32 w u32 h] | u32 n | n × (u32 len input[len] | u8 hasPlace [i32 x y w h])
//   done  : u8 hasNext [table next]
import { AbiError, type ParamTable, Reader, Writer } from "./abi-bytes.ts";
import { byteLength } from "./canonical.ts";
import { SPEC_LIMITS, type SpecLimits } from "./limits.ts";

const MAGIC_SPEC = 0x53534654; // "TFSS"

export interface Place {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TaskSpec {
  input: Uint8Array;
  place?: Place;
}

export type StageSpec =
  | { kind: "stage"; name: string; canvas?: { w: number; h: number }; tasks: TaskSpec[] }
  | { kind: "done"; next: ParamTable | null };

/** `SPEC_LIMITS.maxCanvasSide` and `.maxCanvasPixels` under their older names. */
export const MAX_CANVAS_SIDE = SPEC_LIMITS.maxCanvasSide;
export const MAX_CANVAS_PIXELS = SPEC_LIMITS.maxCanvasPixels;

export function encodeStageSpec(s: StageSpec): Uint8Array {
  const w = new Writer();
  w.header(MAGIC_SPEC);
  if (s.kind === "done") {
    w.u8(1);
    w.u8(s.next ? 1 : 0);
    if (s.next) w.table(s.next);
    return w.done();
  }
  w.u8(0);
  w.str(s.name);
  w.u8(s.canvas ? 1 : 0);
  if (s.canvas) {
    w.u32(s.canvas.w);
    w.u32(s.canvas.h);
  }
  w.u32(s.tasks.length);
  for (const t of s.tasks) {
    w.bytes(t.input);
    w.u8(t.place ? 1 : 0);
    if (t.place) {
      w.i32(t.place.x);
      w.i32(t.place.y);
      w.i32(t.place.w);
      w.i32(t.place.h);
    }
  }
  return w.done();
}

/** Decode and validate a stage spec against the structural caps; throws AbiError on anything off. */
export function decodeStageSpec(b: Uint8Array, limits: SpecLimits = SPEC_LIMITS): StageSpec {
  if (b.length > limits.maxBytes) {
    throw new AbiError(`stage spec is ${b.length} bytes, cap ${limits.maxBytes}`, "cap");
  }
  const r = new Reader(b);
  r.header(MAGIC_SPEC, "stage spec");
  const kind = r.u8();
  if (kind === 1) {
    const next = r.u8() ? r.table() : null;
    r.finish();
    return { kind: "done", next };
  }
  if (kind !== 0) throw r.shape("unknown spec kind");
  const name = r.str();
  if (name.length === 0 || byteLength(name) > limits.maxNameBytes) throw r.cap("bad stage name");
  const spec: StageSpec = { kind: "stage", name, tasks: [] };
  if (r.u8()) {
    const w = r.u32();
    const h = r.u32();
    if (
      w === 0 ||
      h === 0 ||
      w > limits.maxCanvasSide ||
      h > limits.maxCanvasSide ||
      w * h > limits.maxCanvasPixels
    )
      throw r.cap("bad canvas");
    spec.canvas = { w, h };
  }
  const n = r.u32();
  if (n === 0 || n > limits.maxTasks) throw r.cap(`task count ${n} outside 1..${limits.maxTasks}`);
  for (let i = 0; i < n; i++) {
    const input = r.bytes();
    if (input.length > limits.maxInlineInput) {
      throw r.cap(`task ${i} input exceeds ${limits.maxInlineInput} bytes`);
    }
    const task: TaskSpec = { input };
    if (r.u8()) {
      const place = { x: r.i32(), y: r.i32(), w: r.i32(), h: r.i32() };
      if (
        place.w <= 0 ||
        place.h <= 0 ||
        place.w > limits.maxPlaceSide ||
        place.h > limits.maxPlaceSide
      )
        throw r.cap(`task ${i} has a bad placement`);
      task.place = place;
    }
    spec.tasks.push(task);
  }
  r.finish();
  return spec;
}
