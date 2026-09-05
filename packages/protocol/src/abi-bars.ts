// What a `bars` program's final task returns (design §5.1); the dashboard draws it:
//
//   "TFBR" u32 version=1 | u32 count | count × (str label | f64 value)
import { AbiError, Reader, Writer } from "./abi-bytes.ts";
import { BARS_LIMITS, type BarsLimits } from "./limits.ts";

const MAGIC_BARS = 0x52424654; // "TFBR"
const dec = new TextDecoder();

/** One bar of the `bars` view: a label and a finite value. */
export interface Bar {
  label: string;
  value: number;
}

export function encodeBars(bars: Bar[]): Uint8Array {
  const w = new Writer();
  w.header(MAGIC_BARS);
  w.u32(bars.length);
  for (const b of bars) {
    w.str(b.label);
    w.f64(b.value);
  }
  return w.done();
}

/**
 * Decode and validate a `bars` payload: the caps, and every value finite — NaN payload bits differ
 * between engines, so a NaN would make identical programs disagree (design §5.5).
 */
export function decodeBars(b: Uint8Array, limits: BarsLimits = BARS_LIMITS): Bar[] {
  if (b.length > limits.maxBytes) {
    throw new AbiError(`bars payload is ${b.length} bytes, cap ${limits.maxBytes}`, "cap");
  }
  const r = new Reader(b);
  r.header(MAGIC_BARS, "bars payload");
  const n = r.u32();
  if (n > limits.maxBars) throw r.cap(`bar count ${n} exceeds ${limits.maxBars}`);
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const raw = r.bytes();
    if (raw.length > limits.maxLabelBytes) {
      throw r.cap(`bar ${i} label exceeds ${limits.maxLabelBytes} bytes`);
    }
    const value = r.f64();
    if (!Number.isFinite(value)) throw r.shape(`bar ${i} value is not finite`);
    out.push({ label: dec.decode(raw), value });
  }
  r.finish();
  return out;
}
