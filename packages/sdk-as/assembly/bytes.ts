// Little-endian byte writer and reader over linear memory. The ABI formats and programs' own
// compact task inputs are built with these; nothing here depends on the host.

export class ByteWriter {
  private buf: ArrayBuffer;
  private pos: i32 = 0;

  constructor(capacity: i32 = 256) {
    this.buf = new ArrayBuffer(capacity > 16 ? capacity : 16);
  }

  get length(): i32 {
    return this.pos;
  }

  private ensure(n: i32): void {
    if (this.pos + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.pos + n) size *= 2;
    const next = new ArrayBuffer(size);
    memory.copy(changetype<usize>(next), changetype<usize>(this.buf), <usize>this.pos);
    this.buf = next;
  }

  u8(v: u8): ByteWriter {
    this.ensure(1);
    store<u8>(changetype<usize>(this.buf) + <usize>this.pos, v);
    this.pos += 1;
    return this;
  }

  u32(v: u32): ByteWriter {
    this.ensure(4);
    store<u32>(changetype<usize>(this.buf) + <usize>this.pos, v);
    this.pos += 4;
    return this;
  }

  i32(v: i32): ByteWriter {
    this.ensure(4);
    store<i32>(changetype<usize>(this.buf) + <usize>this.pos, v);
    this.pos += 4;
    return this;
  }

  f32(v: f32): ByteWriter {
    this.ensure(4);
    store<f32>(changetype<usize>(this.buf) + <usize>this.pos, v);
    this.pos += 4;
    return this;
  }

  f64(v: f64): ByteWriter {
    this.ensure(8);
    store<f64>(changetype<usize>(this.buf) + <usize>this.pos, v);
    this.pos += 8;
    return this;
  }

  /** Raw bytes, no length prefix. */
  raw(bytes: Uint8Array): ByteWriter {
    const n = bytes.byteLength;
    this.ensure(n);
    memory.copy(changetype<usize>(this.buf) + <usize>this.pos, bytes.dataStart, <usize>n);
    this.pos += n;
    return this;
  }

  /** u32 length followed by the bytes (the ABI's `bytes`). */
  blob(bytes: Uint8Array): ByteWriter {
    this.u32(<u32>bytes.byteLength);
    return this.raw(bytes);
  }

  /** u32 byte length followed by UTF-8 (the ABI's `str`). */
  str(s: string): ByteWriter {
    const encoded = String.UTF8.encode(s);
    const n = encoded.byteLength;
    this.u32(<u32>n);
    this.ensure(n);
    memory.copy(changetype<usize>(this.buf) + <usize>this.pos, changetype<usize>(encoded), <usize>n);
    this.pos += n;
    return this;
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.pos);
    memory.copy(out.dataStart, changetype<usize>(this.buf), <usize>this.pos);
    return out;
  }
}

export class ByteReader {
  private base: usize;
  private end: usize;
  private pos: usize;

  constructor(bytes: Uint8Array) {
    this.base = bytes.dataStart;
    this.pos = this.base;
    this.end = this.base + <usize>bytes.byteLength;
  }

  /** A reader straight over host-provided memory (the ABI entry points). */
  static at(ptr: usize, len: i32): ByteReader {
    const r = new ByteReader(new Uint8Array(0));
    r.base = ptr;
    r.pos = ptr;
    r.end = ptr + <usize>len;
    return r;
  }

  get remaining(): i32 {
    return <i32>(this.end - this.pos);
  }

  private need(n: usize): void {
    if (this.pos + n > this.end) abort("ByteReader: truncated");
  }

  u8(): u8 {
    this.need(1);
    const v = load<u8>(this.pos);
    this.pos += 1;
    return v;
  }

  u32(): u32 {
    this.need(4);
    const v = load<u32>(this.pos);
    this.pos += 4;
    return v;
  }

  i32(): i32 {
    this.need(4);
    const v = load<i32>(this.pos);
    this.pos += 4;
    return v;
  }

  f32(): f32 {
    this.need(4);
    const v = load<f32>(this.pos);
    this.pos += 4;
    return v;
  }

  f64(): f64 {
    this.need(8);
    const v = load<f64>(this.pos);
    this.pos += 8;
    return v;
  }

  /** n raw bytes, copied. */
  bytes(n: i32): Uint8Array {
    this.need(<usize>n);
    const out = new Uint8Array(n);
    memory.copy(out.dataStart, this.pos, <usize>n);
    this.pos += <usize>n;
    return out;
  }

  /** u32 length followed by the bytes. */
  blob(): Uint8Array {
    const n = <i32>this.u32();
    return this.bytes(n);
  }

  /** u32 byte length followed by UTF-8. */
  str(): string {
    const n = <i32>this.u32();
    this.need(<usize>n);
    const s = String.UTF8.decodeUnsafe(this.pos, <usize>n);
    this.pos += <usize>n;
    return s;
  }
}
