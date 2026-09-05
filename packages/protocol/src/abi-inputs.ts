// What `run` and `plan` receive (design §5.3):
//
//   run input  : "TFRN" u32 version=1 | u32 stage | u32 taskIndex | u32 taskCount | u32 len | input[len]
//   plan input : "TFPL" u32 version=1 | u32 stage | table params | table hints
//
// Both decoders leave trailing bytes alone; tightening that is a behaviour decision, not a refactor.
import { type ParamTable, Reader, Writer } from "./abi-bytes.ts";

const MAGIC_RUN = 0x4e524654; // "TFRN" little-endian
const MAGIC_PLAN = 0x4c504654; // "TFPL"

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

export function encodeRunInput(r: RunInput): Uint8Array {
  const w = new Writer();
  w.header(MAGIC_RUN);
  w.u32(r.stage);
  w.u32(r.taskIndex);
  w.u32(r.taskCount);
  w.bytes(r.input);
  return w.done();
}

export function decodeRunInput(b: Uint8Array): RunInput {
  const r = new Reader(b);
  r.header(MAGIC_RUN, "run input");
  return { stage: r.u32(), taskIndex: r.u32(), taskCount: r.u32(), input: r.bytes() };
}

export function encodePlanInput(p: PlanInput): Uint8Array {
  const w = new Writer();
  w.header(MAGIC_PLAN);
  w.u32(p.stage);
  w.table(p.params);
  w.table(p.hints);
  return w.done();
}

export function decodePlanInput(b: Uint8Array): PlanInput {
  const r = new Reader(b);
  r.header(MAGIC_PLAN, "plan input");
  return { stage: r.u32(), params: r.table(), hints: r.table() };
}
