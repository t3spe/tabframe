// The ABI's primitives (design §5.3): little-endian, deterministic, trivial to produce from
// AssemblyScript and to parse on the control plane. The SDK mirrors every layout byte for byte.
//
//   str   : u32 len | utf8[len]
//   table : u32 count | count × (str key | str value)   — values are JSON text, keys sorted
import { SPEC_LIMITS } from "./limits.ts";

export const ABI_VERSION = 1;

/** Params and hints travel as a flat table of key → JSON text, so a program needs no JSON parser. */
export type ParamTable = Record<string, unknown>;

export type AbiErrorCode = "magic" | "version" | "truncated" | "cap" | "shape";

/** A payload that does not decode: `code` says why, `at` is the reader's byte offset when the check failed. */
export class AbiError extends Error {
  readonly code: AbiErrorCode;
  readonly at: number;
  constructor(message: string, code: AbiErrorCode, at = 0) {
    super(message);
    this.code = code;
    this.at = at;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A growing little-endian buffer. */
export class Writer {
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
  /** The magic and the ABI version every payload starts with. */
  header(magic: number): void {
    this.u32(magic);
    this.u32(ABI_VERSION);
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

/** A bounds-checked little-endian reader; every failure is an AbiError carrying the offset. */
export class Reader {
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
  /** The magic and the version, or the error every decoder gives for a foreign payload. */
  header(magic: number, what: string): void {
    if (this.u32() !== magic) throw new AbiError(`not a ${what}`, "magic", 0);
    if (this.u32() !== ABI_VERSION) throw new AbiError("unsupported ABI version", "version", 4);
  }
  /** The payload must end here. */
  finish(): void {
    if (this.remaining !== 0) throw this.shape("trailing bytes");
  }
  /** A structural cap exceeded at the current offset. */
  cap(message: string): AbiError {
    return new AbiError(message, "cap", this.pos);
  }
  /** Bytes that are well-formed but mean nothing valid at the current offset. */
  shape(message: string): AbiError {
    return new AbiError(message, "shape", this.pos);
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
    if (count > SPEC_LIMITS.maxTableEntries) throw this.cap("table too large");
    const out: ParamTable = {};
    for (let i = 0; i < count; i++) {
      const key = this.str();
      const text = this.str();
      try {
        out[key] = JSON.parse(text);
      } catch {
        throw this.shape(`table value for ${key} is not JSON`);
      }
    }
    return out;
  }
  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new AbiError("truncated", "truncated", this.pos);
  }
}
