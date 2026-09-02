// A plain JavaScript word count with exactly the program's word rule, so the tests can say what
// the distributed answer must be. Kept deliberately naive: one pass over the whole text.

/** ASCII letters and the apostrophe are word bytes; everything else separates. */
export function isWordByte(b: number): boolean {
  return (b >= 97 && b <= 122) || (b >= 65 && b <= 90) || b === 39;
}

/** Count every word of a buffer: maximal runs of word bytes, apostrophes trimmed, lowercased. */
export function countWords(
  text: Uint8Array,
  into = new Map<string, number>(),
): Map<string, number> {
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (!isWordByte(text[i] as number)) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && isWordByte(text[j] as number)) j++;
    let a = i;
    let b = j;
    while (a < b && text[a] === 39) a++;
    while (b > a && text[b - 1] === 39) b--;
    if (b > a) {
      const word = String.fromCharCode(...text.subarray(a, b)).toLowerCase();
      into.set(word, (into.get(word) ?? 0) + 1);
    }
    i = j;
  }
  return into;
}

/** Top-K by count descending, then word ascending by UTF-16 code units (what the program does). */
export function topK(counts: Map<string, number>, k: number): Array<[string, number]> {
  return [...counts.entries()]
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .slice(0, k);
}

/** FNV-1a over the word's bytes modulo the partition count, as the program buckets. */
export function partitionOf(word: string, partitions: number): number {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(word)) {
    h ^= byte;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % partitions;
}

/** Decode a map output: partition sections of (word, count) pairs. */
export function decodeMapOutput(bytes: Uint8Array): Array<Array<[string, number]>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const partitions = view.getUint32(0, true);
  const out: Array<Array<[string, number]>> = [];
  for (let p = 0; p < partitions; p++) {
    const offset = view.getUint32(4 + p * 8, true);
    const length = view.getUint32(8 + p * 8, true);
    out.push(decodePairs(bytes.subarray(offset, offset + length)));
  }
  return out;
}

/** Decode `u32 count | count × (str word, u32 count)`. */
export function decodePairs(bytes: Uint8Array): Array<[string, number]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  let pos = 0;
  const count = view.getUint32(pos, true);
  pos += 4;
  const pairs: Array<[string, number]> = [];
  for (let i = 0; i < count; i++) {
    const len = view.getUint32(pos, true);
    pos += 4;
    const word = dec.decode(bytes.subarray(pos, pos + len));
    pos += len;
    const c = view.getUint32(pos, true);
    pos += 4;
    pairs.push([word, c]);
  }
  if (pos !== bytes.length) throw new Error(`trailing bytes in pairs (${bytes.length - pos})`);
  return pairs;
}

/** Sum a list of (word, count) lists into one map. */
export function merge(lists: Array<Array<[string, number]>>): Map<string, number> {
  const out = new Map<string, number>();
  for (const list of lists) for (const [w, c] of list) out.set(w, (out.get(w) ?? 0) + c);
  return out;
}

export const encodeText = (s: string): Uint8Array => new TextEncoder().encode(s);
