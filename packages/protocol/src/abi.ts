/**
 * The program ABI's byte formats (design §5.3): what `run` and `plan` receive and what `plan`
 * returns. Binary, little-endian, deterministic, trivial to produce from AssemblyScript and to
 * parse on the control plane. The SDK mirrors these layouts exactly.
 *
 *   run input   : "TFRN" u32 version=1 | u32 stage | u32 taskIndex | u32 taskCount | u32 len | input[len]
 *   plan input  : "TFPL" u32 version=1 | u32 stage | table params | table hints
 *   plan output : "TFSS" u32 version=1 | u8 kind (0 = stage, 1 = done)
 *                 stage: str name | u8 hasCanvas [u32 w u32 h] | u32 n | n × (u32 len input[len] | u8 hasPlace [i32 x y w h])
 *                 done : u8 hasNext [table next]
 *   bars        : "TFBR" u32 version=1 | u32 count | count × (str label | f64 value)
 *                 — what a `bars` program's final task returns (design §5.1); the dashboard draws it
 *   table       : u32 count | count × (str key | str value)   — values are JSON text
 *   str         : u32 len | utf8[len]
 */

export const ABI_VERSION = 1;
const MAGIC_RUN = 0x4e524654; // "TFRN" little-endian
const MAGIC_PLAN = 0x4c504654; // "TFPL"
const MAGIC_SPEC = 0x53534654; // "TFSS"
const MAGIC_BARS = 0x52424654; // "TFBR"

/** Params and hints travel as a flat table of key → JSON text, so a program needs no JSON parser. */
export type ParamTable = Record<string, unknown>;

export interface RunInput {
  stage: number;
  taskIndex: number;
  taskCount: number;
  input: Uint8Array;
}

export interface PlanInput {
  stage: number;
  params: ParamTable;
  hints: ParamTable;
}

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

/** Structural caps on a stage spec (design §5.2). */
export const SPEC_LIMITS = {
  maxTasks: 4096,
  maxBytes: 1024 * 1024,
  maxInlineInput: 16 * 1024,
  maxNameBytes: 64,
} as const;

/** One bar of the `bars` view: a label and a finite value. */
export interface Bar {
  label: string;
  value: number;
}

/** Structural caps on a bars payload: enough for a top-K, small enough to draw. */
export const BARS_LIMITS = {
  maxBars: 4096,
  maxLabelBytes: 256,
  maxBytes: 1024 * 1024,
} as const;

const enc = new TextEncoder();
const dec = new TextDecoder();

class Writer {
  private buf = new Uint8Array(1024);
  private view = new DataView(this.buf.buffer);
  private pos = 0;
  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
  }
  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
  }
  i32(v: number): void {
    this.ensure(4);
    this.view.setInt32(this.pos, v | 0, true);
    this.pos += 4;
  }
  f64(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }
  bytes(b: Uint8Array): void {
    this.u32(b.length);
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }
  str(s: string): void {
    this.bytes(enc.encode(s));
  }
  table(t: ParamTable): void {
    const keys = Object.keys(t).sort();
    this.u32(keys.length);
    for (const k of keys) {
      this.str(k);
      this.str(JSON.stringify(t[k] ?? null));
    }
  }
  done(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

class Reader {
  private readonly view: DataView;
  private readonly buf: Uint8Array;
  private pos = 0;
  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get remaining(): number {
    return this.buf.length - this.pos;
  }
  u8(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  bytes(): Uint8Array {
    const len = this.u32();
    this.need(len);
    const out = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  str(): string {
    return dec.decode(this.bytes());
  }
  table(): ParamTable {
    const count = this.u32();
    if (count > 4096) throw new AbiError("table too large");
    const out: ParamTable = {};
    for (let i = 0; i < count; i++) {
      const key = this.str();
      const text = this.str();
      try {
        out[key] = JSON.parse(text);
      } catch {
        throw new AbiError(`table value for ${key} is not JSON`);
      }
    }
    return out;
  }
  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new AbiError("truncated");
  }
}

export const MAX_CANVAS_SIDE = 4096;
export const MAX_CANVAS_PIXELS = 4 * 1024 * 1024;

export class AbiError extends Error {}

export function encodeRunInput(r: RunInput): Uint8Array {
  const w = new Writer();
  w.u32(MAGIC_RUN);
  w.u32(ABI_VERSION);
  w.u32(r.stage);
  w.u32(r.taskIndex);
  w.u32(r.taskCount);
  w.bytes(r.input);
  return w.done();
}

export function decodeRunInput(b: Uint8Array): RunInput {
  const r = new Reader(b);
  if (r.u32() !== MAGIC_RUN) throw new AbiError("not a run input");
  if (r.u32() !== ABI_VERSION) throw new AbiError("unsupported ABI version");
  return { stage: r.u32(), taskIndex: r.u32(), taskCount: r.u32(), input: r.bytes() };
}

export function encodePlanInput(p: PlanInput): Uint8Array {
  const w = new Writer();
  w.u32(MAGIC_PLAN);
  w.u32(ABI_VERSION);
  w.u32(p.stage);
  w.table(p.params);
  w.table(p.hints);
  return w.done();
}

export function decodePlanInput(b: Uint8Array): PlanInput {
  const r = new Reader(b);
  if (r.u32() !== MAGIC_PLAN) throw new AbiError("not a plan input");
  if (r.u32() !== ABI_VERSION) throw new AbiError("unsupported ABI version");
  return { stage: r.u32(), params: r.table(), hints: r.table() };
}

export function encodeStageSpec(s: StageSpec): Uint8Array {
  const w = new Writer();
  w.u32(MAGIC_SPEC);
  w.u32(ABI_VERSION);
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
export function decodeStageSpec(b: Uint8Array, limits = SPEC_LIMITS): StageSpec {
  if (b.length > limits.maxBytes)
    throw new AbiError(`stage spec is ${b.length} bytes, cap ${limits.maxBytes}`);
  const r = new Reader(b);
  if (r.u32() !== MAGIC_SPEC) throw new AbiError("not a stage spec");
  if (r.u32() !== ABI_VERSION) throw new AbiError("unsupported ABI version");
  const kind = r.u8();
  if (kind === 1) {
    const hasNext = r.u8();
    const next = hasNext ? r.table() : null;
    if (r.remaining !== 0) throw new AbiError("trailing bytes");
    return { kind: "done", next };
  }
  if (kind !== 0) throw new AbiError("unknown spec kind");
  const name = r.str();
  if (name.length === 0 || enc.encode(name).length > limits.maxNameBytes)
    throw new AbiError("bad stage name");
  const spec: StageSpec = { kind: "stage", name, tasks: [] };
  if (r.u8()) {
    const w = r.u32();
    const h = r.u32();
    // At most 4096 a side and four megapixels (WP8.3): a 16384² canvas is a gigabyte of RGBA that
    // every dashboard would allocate on a stranger's say-so.
    if (
      w === 0 ||
      h === 0 ||
      w > MAX_CANVAS_SIDE ||
      h > MAX_CANVAS_SIDE ||
      w * h > MAX_CANVAS_PIXELS
    )
      throw new AbiError("bad canvas");
    spec.canvas = { w, h };
  }
  const n = r.u32();
  if (n === 0 || n > limits.maxTasks)
    throw new AbiError(`task count ${n} outside 1..${limits.maxTasks}`);
  for (let i = 0; i < n; i++) {
    const input = r.bytes();
    if (input.length > limits.maxInlineInput)
      throw new AbiError(`task ${i} input exceeds ${limits.maxInlineInput} bytes`);
    const task: TaskSpec = { input };
    if (r.u8()) {
      const place = { x: r.i32(), y: r.i32(), w: r.i32(), h: r.i32() };
      if (place.w <= 0 || place.h <= 0 || place.w > 4096 || place.h > 4096)
        throw new AbiError(`task ${i} has a bad placement`);
      task.place = place;
    }
    spec.tasks.push(task);
  }
  if (r.remaining !== 0) throw new AbiError("trailing bytes");
  return spec;
}

export function encodeBars(bars: Bar[]): Uint8Array {
  const w = new Writer();
  w.u32(MAGIC_BARS);
  w.u32(ABI_VERSION);
  w.u32(bars.length);
  for (const b of bars) {
    w.str(b.label);
    w.f64(b.value);
  }
  return w.done();
}

/**
 * Decode and validate a `bars` payload: the caps above, and every value finite — NaN payload bits
 * differ between engines, so a NaN would make identical programs disagree (design §5.5).
 */
export function decodeBars(
  b: Uint8Array,
  limits: { maxBars: number; maxLabelBytes: number; maxBytes: number } = BARS_LIMITS,
): Bar[] {
  if (b.length > limits.maxBytes)
    throw new AbiError(`bars payload is ${b.length} bytes, cap ${limits.maxBytes}`);
  const r = new Reader(b);
  if (r.u32() !== MAGIC_BARS) throw new AbiError("not a bars payload");
  if (r.u32() !== ABI_VERSION) throw new AbiError("unsupported ABI version");
  const n = r.u32();
  if (n > limits.maxBars) throw new AbiError(`bar count ${n} exceeds ${limits.maxBars}`);
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const raw = r.bytes();
    if (raw.length > limits.maxLabelBytes)
      throw new AbiError(`bar ${i} label exceeds ${limits.maxLabelBytes} bytes`);
    const value = r.f64();
    if (!Number.isFinite(value)) throw new AbiError(`bar ${i} value is not finite`);
    out.push({ label: dec.decode(raw), value });
  }
  if (r.remaining !== 0) throw new AbiError("trailing bytes");
  return out;
}
