// A flat table of key → JSON text (the ABI's `table`). Programs read scalars without a JSON
// parser; keys are written sorted so identical tables are identical bytes.
import { ByteReader, ByteWriter } from "./bytes";

export class Params {
  keys: string[] = [];
  values: string[] = [];

  static read(r: ByteReader): Params {
    const p = new Params();
    const count = <i32>r.u32();
    for (let i = 0; i < count; i++) {
      const key = r.str();
      const value = r.str();
      p.set(key, value);
    }
    return p;
  }

  write(w: ByteWriter): void {
    const n = this.keys.length;
    const order = new Array<i32>(n);
    for (let i = 0; i < n; i++) order[i] = i;
    // Insertion sort by key; tables are small.
    for (let i = 1; i < n; i++) {
      const cur = order[i];
      let j = i - 1;
      while (j >= 0 && this.keys[order[j]] > this.keys[cur]) {
        order[j + 1] = order[j];
        j--;
      }
      order[j + 1] = cur;
    }
    w.u32(<u32>n);
    for (let i = 0; i < n; i++) {
      w.str(this.keys[order[i]]);
      w.str(this.values[order[i]]);
    }
  }

  get size(): i32 {
    return this.keys.length;
  }

  has(key: string): bool {
    return this.indexOf(key) >= 0;
  }

  indexOf(key: string): i32 {
    for (let i = 0; i < this.keys.length; i++) if (this.keys[i] == key) return i;
    return -1;
  }

  /** The raw JSON text, or null. */
  raw(key: string): string | null {
    const i = this.indexOf(key);
    return i < 0 ? null : this.values[i];
  }

  /** Set the JSON text directly. */
  set(key: string, jsonText: string): Params {
    const i = this.indexOf(key);
    if (i >= 0) this.values[i] = jsonText;
    else {
      this.keys.push(key);
      this.values.push(jsonText);
    }
    return this;
  }

  setString(key: string, value: string): Params {
    return this.set(key, quote(value));
  }

  setI32(key: string, value: i32): Params {
    return this.set(key, value.toString());
  }

  setF64(key: string, value: f64): Params {
    return this.set(key, value.toString());
  }

  setBool(key: string, value: bool): Params {
    return this.set(key, value ? "true" : "false");
  }

  getString(key: string, fallback: string): string {
    const v = this.raw(key);
    if (v === null) return fallback;
    const text = v as string;
    if (text.length >= 2 && text.charCodeAt(0) == 34) return unquote(text);
    return text;
  }

  getF64(key: string, fallback: f64): f64 {
    const v = this.raw(key);
    if (v === null) return fallback;
    let text = v as string;
    if (text.length >= 2 && text.charCodeAt(0) == 34) text = unquote(text);
    if (text.length == 0) return fallback;
    const n = F64.parseFloat(text);
    return isNaN(n) ? fallback : n;
  }

  getI32(key: string, fallback: i32): i32 {
    const v = this.raw(key);
    if (v === null) return fallback;
    let text = v as string;
    if (text.length >= 2 && text.charCodeAt(0) == 34) text = unquote(text);
    if (text.length == 0) return fallback;
    const n = F64.parseFloat(text);
    if (isNaN(n)) return fallback;
    return <i32>n;
  }

  getBool(key: string, fallback: bool): bool {
    const v = this.raw(key);
    if (v === null) return fallback;
    const text = v as string;
    if (text == "true") return true;
    if (text == "false") return false;
    return fallback;
  }
}

/** JSON-quote a string (the escapes JSON requires; everything else verbatim). */
export function quote(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c == 34) out += '\\"';
    else if (c == 92) out += "\\\\";
    else if (c == 10) out += "\\n";
    else if (c == 13) out += "\\r";
    else if (c == 9) out += "\\t";
    else if (c < 32) {
      out += "\\u00";
      out += (c >> 4).toString(16);
      out += (c & 15).toString(16);
    } else out += String.fromCharCode(c);
  }
  return out + '"';
}

/** Decode a JSON string literal (the standard escapes, including \uXXXX). */
export function unquote(text: string): string {
  let out = "";
  const n = text.length - 1;
  let i = 1;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c != 92) {
      out += String.fromCharCode(c);
      i++;
      continue;
    }
    i++;
    if (i >= n) break;
    const e = text.charCodeAt(i);
    if (e == 110) out += "\n";
    else if (e == 116) out += "\t";
    else if (e == 114) out += "\r";
    else if (e == 98) out += "\b";
    else if (e == 102) out += "\f";
    else if (e == 117 && i + 4 < text.length) {
      const code = <i32>I32.parseInt(text.substring(i + 1, i + 5), 16);
      out += String.fromCharCode(code);
      i += 4;
    } else out += String.fromCharCode(e);
    i++;
  }
  return out;
}
