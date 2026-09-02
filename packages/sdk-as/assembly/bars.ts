// The `bars` view payload (design §5.1), byte for byte the same as packages/protocol/src/abi.ts:
//
//   bars : "TFBR" u32 version=1 | u32 count | count × (str label | f64 value)
//
// A `bars` program's final task returns this and the dashboard draws it. Values must be finite:
// NaN payload bits differ between engines, and twins must agree byte for byte.
import { ABI_VERSION } from "./abi";
import { ByteWriter } from "./bytes";

const MAGIC_BARS: u32 = 0x52424654; // "TFBR"

export class Bars {
  private labels: string[] = [];
  private values: f64[] = [];

  bar(label: string, value: f64): Bars {
    if (isNaN(value) || !isFinite(value)) abort("bars: value must be finite");
    this.labels.push(label);
    this.values.push(value);
    return this;
  }

  get length(): i32 {
    return this.labels.length;
  }

  toBytes(): Uint8Array {
    const w = new ByteWriter(16 + this.labels.length * 32);
    w.u32(MAGIC_BARS).u32(ABI_VERSION).u32(<u32>this.labels.length);
    for (let i = 0; i < this.labels.length; i++) w.str(this.labels[i]).f64(this.values[i]);
    return w.toBytes();
  }
}

/** Builder for a bars payload: `bars().bar("the", 14000).bar("of", 6500).toBytes()`. */
export function bars(): Bars {
  return new Bars();
}
