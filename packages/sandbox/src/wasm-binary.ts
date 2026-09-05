// The sections the validator needs — imports (2), memories (5), exports (7) — read straight from a
// module's bytes in one bounds-checked pass. The JS API exposes neither a memory's limits nor a way
// to read a module's shape without compiling it, and the control plane must not compile a
// stranger's eight megabytes on its event loop (design §2).

export interface MemoryLimits {
  min: number;
  max: number | null;
  shared: boolean;
  memory64: boolean;
}

/** An import or export as the binary declares it; `kind` matches the JS API's names. */
export interface ModuleShape {
  imports: Array<{ module: string; name: string; kind: string }>;
  exports: Array<{ name: string; kind: string }>;
}

export interface ModuleSections extends ModuleShape {
  memories: MemoryLimits[];
}

const KINDS = ["function", "table", "memory", "global", "tag"] as const;
const MAGIC = [0x00, 0x61, 0x73, 0x6d];
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** A cursor over a byte range; every read past `end` throws, so no section can run off its bounds. */
export class ByteCursor {
  private readonly bytes: Uint8Array;
  private pos: number;
  private readonly end: number;

  constructor(bytes: Uint8Array, start: number, end: number) {
    this.bytes = bytes;
    this.pos = start;
    this.end = end;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  u8(): number {
    if (this.pos >= this.end) throw new RangeError("truncated");
    return this.bytes[this.pos++] as number;
  }

  /** Unsigned LEB128 of at most 32 bits. */
  leb(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.u8();
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result >>> 0;
      shift += 7;
      if (shift > 35) throw new RangeError("bad LEB128");
    }
  }

  /** A length-prefixed UTF-8 name. */
  name(): string {
    const len = this.leb();
    if (this.pos + len > this.end) throw new RangeError("truncated");
    const text = utf8.decode(this.bytes.subarray(this.pos, this.pos + len));
    this.pos += len;
    return text;
  }

  skip(n: number): void {
    if (this.pos + n > this.end) throw new RangeError("truncated");
    this.pos += n;
  }

  /** A cursor confined to the next `size` bytes; this one moves past them. */
  sub(size: number): ByteCursor {
    if (this.pos + size > this.end) throw new RangeError("truncated");
    const inner = new ByteCursor(this.bytes, this.pos, this.pos + size);
    this.pos += size;
    return inner;
  }

  /** Memory or table limits: flags (0x01 has a maximum, 0x02 shared, 0x04 64-bit), min, [max]. */
  limits(): MemoryLimits {
    const flags = this.leb();
    const min = this.leb();
    const max = flags & 0x01 ? this.leb() : null;
    return { min, max, shared: (flags & 0x02) !== 0, memory64: (flags & 0x04) !== 0 };
  }
}

/** Imports, memories, and exports of a module; null when the bytes are not a well-formed module. */
export function readModuleSections(bytes: Uint8Array): ModuleSections | null {
  if (bytes.length < 8 || !MAGIC.every((b, i) => bytes[i] === b)) return null;
  const out: ModuleSections = { imports: [], exports: [], memories: [] };
  try {
    const cursor = new ByteCursor(bytes, 8, bytes.length);
    while (!cursor.done) {
      const id = cursor.u8();
      const section = cursor.sub(cursor.leb());
      if (id === 2) readImports(section, out);
      else if (id === 5) {
        const count = section.leb();
        for (let i = 0; i < count; i++) out.memories.push(section.limits());
      } else if (id === 7) {
        const count = section.leb();
        for (let i = 0; i < count; i++) {
          const name = section.name();
          const kind = kindOf(section.u8());
          section.leb();
          out.exports.push({ name, kind });
        }
      }
    }
  } catch {
    return null;
  }
  return out;
}

function readImports(section: ByteCursor, into: ModuleSections): void {
  const count = section.leb();
  for (let i = 0; i < count; i++) {
    const module = section.name();
    const name = section.name();
    const kind = kindOf(section.u8());
    // The descriptor is skipped by kind; only its presence matters here.
    if (kind === "function") section.leb();
    else if (kind === "table") {
      section.skip(1);
      section.limits();
    } else if (kind === "memory") section.limits();
    else if (kind === "global") section.skip(2);
    else {
      section.skip(1);
      section.leb();
    }
    into.imports.push({ module, name, kind });
  }
}

function kindOf(code: number): (typeof KINDS)[number] {
  const kind = KINDS[code];
  if (kind === undefined) throw new RangeError(`unknown kind ${code}`);
  return kind;
}
