// The program ABI (design §5.3), byte for byte the same as packages/protocol/src/abi.ts:
//
//   run input   : "TFRN" u32 version=1 | u32 stage | u32 taskIndex | u32 taskCount | u32 len | input[len]
//   plan input  : "TFPL" u32 version=1 | u32 stage | table params | table hints
//   plan output : "TFSS" u32 version=1 | u8 kind (0 = stage, 1 = done)
//                 stage: str name | u8 hasCanvas [u32 w u32 h] | u32 n | n × (u32 len input[len] | u8 hasPlace [i32 x y w h])
//                 done : u8 hasNext [table next]
//   table       : u32 count | count × (str key | str value)   — values are JSON text, keys sorted
//   str         : u32 len | utf8[len]
//
// Entry points return a pointer to an 8-byte {outPtr: u32, outLen: u32} pair (`emit`).
import { ByteReader, ByteWriter } from "./bytes";
import { Params } from "./params";

export const ABI_VERSION: u32 = 1;
const MAGIC_RUN: u32 = 0x4e524654; // "TFRN"
const MAGIC_PLAN: u32 = 0x4c504654; // "TFPL"
const MAGIC_SPEC: u32 = 0x53534654; // "TFSS"

/** The host allocates input buffers through this; programs re-export it. */
export function alloc(len: i32): usize {
  const size: usize = len > 0 ? <usize>len : 1;
  return __new(size, idof<ArrayBuffer>());
}

/** What `run` receives. */
export class RunInput {
  stage: u32 = 0;
  taskIndex: u32 = 0;
  taskCount: u32 = 0;
  input: Uint8Array = new Uint8Array(0);
}

export function readRunInput(ptr: usize, len: i32): RunInput {
  const r = ByteReader.at(ptr, len);
  if (r.u32() != MAGIC_RUN) abort("not a run input");
  if (r.u32() != ABI_VERSION) abort("unsupported ABI version");
  const out = new RunInput();
  out.stage = r.u32();
  out.taskIndex = r.u32();
  out.taskCount = r.u32();
  out.input = r.blob();
  return out;
}

/** What `plan` receives. */
export class PlanInput {
  stage: u32 = 0;
  params: Params = new Params();
  hints: Params = new Params();
}

export function readPlanInput(ptr: usize, len: i32): PlanInput {
  const r = ByteReader.at(ptr, len);
  if (r.u32() != MAGIC_PLAN) abort("not a plan input");
  if (r.u32() != ABI_VERSION) abort("unsupported ABI version");
  const out = new PlanInput();
  out.stage = r.u32();
  out.params = Params.read(r);
  out.hints = Params.read(r);
  return out;
}

class TaskEntry {
  constructor(
    public input: Uint8Array,
    public placed: bool,
    public x: i32,
    public y: i32,
    public w: i32,
    public h: i32,
  ) {}
}

/** Builder for the stage a planner returns: `stage("render").canvas(2048, 1280).task(bytes, x, y, w, h)...toBytes()`. */
export class Stage {
  private name: string;
  private hasCanvas: bool = false;
  private canvasW: u32 = 0;
  private canvasH: u32 = 0;
  private tasks: TaskEntry[] = [];

  constructor(name: string) {
    this.name = name;
  }

  canvas(w: u32, h: u32): Stage {
    this.hasCanvas = true;
    this.canvasW = w;
    this.canvasH = h;
    return this;
  }

  /** A task with inline input and no placement. */
  task(input: Uint8Array): Stage {
    this.tasks.push(new TaskEntry(input, false, 0, 0, 0, 0));
    return this;
  }

  /** A task whose output is placed at a rectangle of the canvas (the tiles view). */
  taskAt(input: Uint8Array, x: i32, y: i32, w: i32, h: i32): Stage {
    this.tasks.push(new TaskEntry(input, true, x, y, w, h));
    return this;
  }

  get taskCount(): i32 {
    return this.tasks.length;
  }

  toBytes(): Uint8Array {
    const w = new ByteWriter(64 + this.tasks.length * 96);
    w.u32(MAGIC_SPEC).u32(ABI_VERSION).u8(0).str(this.name);
    if (this.hasCanvas) w.u8(1).u32(this.canvasW).u32(this.canvasH);
    else w.u8(0);
    w.u32(<u32>this.tasks.length);
    for (let i = 0; i < this.tasks.length; i++) {
      const t = this.tasks[i];
      w.blob(t.input);
      if (t.placed) w.u8(1).i32(t.x).i32(t.y).i32(t.w).i32(t.h);
      else w.u8(0);
    }
    return w.toBytes();
  }
}

export function stage(name: string): Stage {
  return new Stage(name);
}

/** The planner's "finished" answer, with optional params for a follow-up execution. */
export function done(next: Params | null): Uint8Array {
  const w = new ByteWriter(64);
  w.u32(MAGIC_SPEC).u32(ABI_VERSION).u8(1);
  if (next === null) w.u8(0);
  else {
    w.u8(1);
    (next as Params).write(w);
  }
  return w.toBytes();
}

/** Hand bytes back to the host: returns the pointer to the {outPtr, outLen} pair the ABI requires. */
export function emit(bytes: Uint8Array): usize {
  const pair = __new(8, idof<ArrayBuffer>());
  store<u32>(pair, <u32>bytes.dataStart);
  store<u32>(pair, <u32>bytes.byteLength, 4);
  return pair;
}
