// Word count (design §5.6): three stages over /in/corpus.txt.
//
//   stage 0 "map"    — mapTasks tasks, each a byte range of the corpus. A task owns the words that
//                      *start* inside its range: it skips a word straddling its start (the previous
//                      task owns it) and reads past its end to finish a word straddling its end.
//                      Output: counts bucketed into PARTITIONS partitions by FNV-1a of the word.
//   stage 1 "reduce" — one task per partition: read every map output under /out/0/, slice this
//                      partition, sum. Output: the partition sorted by count desc, word asc.
//   stage 2 "merge"  — one task: read the eight reduce outputs, take the global top-K. Exact,
//                      because partitions are disjoint. Output: the `bars` payload the dashboard draws.
//   stage 3          — done, no follow-up.
//
// The word rule, on bytes: a word is a maximal run of ASCII letters and apostrophes, with leading
// and trailing apostrophes stripped, lowercased. Everything else — digits, punctuation, whitespace,
// any non-ASCII byte — separates words. The corpus is normalized at build time so typographic
// apostrophes are ASCII ones (packages/sdk-as/scripts/corpus.ts). Deterministic by construction:
// no floating point until the final bar values, and every output is sorted.
import {
  bars,
  ByteReader,
  ByteWriter,
  done,
  emit,
  fs,
  log,
  readPlanInput,
  readRunInput,
  stage,
} from "@tabframe/sdk-as/assembly/index";

export { alloc } from "@tabframe/sdk-as/assembly/index";

const CORPUS = "/in/corpus.txt";
const PARTITIONS: i32 = 8;
const MAX_MAP_TASKS: i32 = 4096;
const MAX_K: i32 = 4096;
/** Bytes read at a time past a range's end to finish a straddling word. */
const TAIL_CHUNK: i32 = 4096;

function isWordByte(b: u8): bool {
  return (b >= 97 && b <= 122) || (b >= 65 && b <= 90) || b == 39;
}

function lower(b: u8): u8 {
  return b >= 65 && b <= 90 ? b + 32 : b;
}

/** FNV-1a over the word's bytes, modulo the partition count. */
function partitionOf(word: string, partitions: i32): i32 {
  const bytes = String.UTF8.encode(word);
  const base = changetype<usize>(bytes);
  let h: u32 = 2166136261;
  for (let i = 0; i < bytes.byteLength; i++) {
    h ^= <u32>load<u8>(base + <usize>i);
    h *= 16777619;
  }
  return <i32>(h % <u32>partitions);
}

export function plan(ptr: usize, len: i32): usize {
  const input = readPlanInput(ptr, len);
  const k = input.params.getI32In("k", 25, 1, MAX_K);
  const mapTasks = input.params.getI32In("mapTasks", 32, 1, MAX_MAP_TASKS);

  if (input.stage == 0) {
    const size = fs.stat(CORPUS);
    if (size < 0) abort("missing " + CORPUS);
    const total = <i32>size;
    const s = stage("map");
    for (let i = 0; i < mapTasks; i++) {
      const start = <i32>((<i64>total * <i64>i) / <i64>mapTasks);
      const end = <i32>((<i64>total * <i64>(i + 1)) / <i64>mapTasks);
      const w = new ByteWriter(16);
      w.u32(<u32>start).u32(<u32>end).u32(<u32>total).u32(<u32>PARTITIONS);
      s.task(w.toBytes());
    }
    return emit(s.toBytes());
  }
  if (input.stage == 1) {
    const s = stage("reduce");
    for (let p = 0; p < PARTITIONS; p++) {
      const w = new ByteWriter(8);
      w.u32(<u32>p).u32(<u32>mapTasks);
      s.task(w.toBytes());
    }
    return emit(s.toBytes());
  }
  if (input.stage == 2) {
    const w = new ByteWriter(8);
    w.u32(<u32>k).u32(<u32>PARTITIONS);
    return emit(stage("merge").task(w.toBytes()).toBytes());
  }
  return emit(done(null));
}

export function run(ptr: usize, len: i32): usize {
  const t = readRunInput(ptr, len);
  if (t.stage == 0) return emit(mapTask(t.input));
  if (t.stage == 1) return emit(reduceTask(t.input));
  if (t.stage == 2) return emit(mergeTask(t.input));
  abort("unexpected stage " + t.stage.toString());
  return 0;
}

function mustRead(offset: i32, length: i32): Uint8Array {
  const bytes = fs.readRange(CORPUS, offset, length);
  if (bytes === null) abort("missing " + CORPUS);
  return bytes as Uint8Array;
}

/**
 * The bytes whose words this task owns, lowercased: the range minus a word straddling its start,
 * plus the rest of a word straddling its end (read in chunks, so a word longer than any buffer is
 * still finished). After the head skip the first byte is a separator or the corpus start, so every
 * word in the result starts inside the range; the tail stops at the first separator, so it adds
 * no word that starts past the end.
 */
function ownedBytes(start: i32, end: i32, total: i32): Uint8Array {
  const buf: Uint8Array = end > start ? mustRead(start, end - start) : new Uint8Array(0);
  let headSkip = 0;
  if (start > 0 && buf.length > 0) {
    const prev = mustRead(start - 1, 1);
    if (prev.length == 1 && isWordByte(prev[0])) {
      while (headSkip < buf.length && isWordByte(buf[headSkip])) headSkip++;
    }
  }
  const tail = new ByteWriter(64);
  if (buf.length > headSkip && isWordByte(buf[buf.length - 1]) && end < total) {
    let pos = end;
    while (pos < total) {
      const chunk = mustRead(pos, TAIL_CHUNK);
      if (chunk.length == 0) break;
      let j = 0;
      while (j < chunk.length && isWordByte(chunk[j])) j++;
      tail.raw(j == chunk.length ? chunk : chunk.subarray(0, j));
      if (j < chunk.length) break;
      pos += chunk.length;
    }
  }
  const tailBytes = tail.toBytes();
  const out = new Uint8Array(buf.length - headSkip + tailBytes.length);
  let o = 0;
  for (let i = headSkip; i < buf.length; i++) out[o++] = lower(buf[i]);
  for (let i = 0; i < tailBytes.length; i++) out[o++] = lower(tailBytes[i]);
  return out;
}

/** Count the words of a lowercased buffer. */
function countWords(text: Uint8Array, counts: Map<string, u32>): void {
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (!isWordByte(text[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && isWordByte(text[j])) j++;
    let a = i;
    let b = j;
    while (a < b && text[a] == 39) a++;
    while (b > a && text[b - 1] == 39) b--;
    if (b > a) {
      const word = String.UTF8.decodeUnsafe(text.dataStart + <usize>a, <usize>(b - a));
      counts.set(word, counts.has(word) ? counts.get(word) + 1 : 1);
    }
    i = j;
  }
}

function byWord(a: string, b: string): i32 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Map output: u32 partitions | partitions × (u32 offset, u32 length) | sections, where a section is
 * u32 count | count × (str word, u32 count) sorted by word. Offsets are from the start of the
 * output, so a reducer reads the header and then exactly its slice.
 */
function mapTask(input: Uint8Array): Uint8Array {
  const r = new ByteReader(input);
  const start = <i32>r.u32();
  const end = <i32>r.u32();
  const total = <i32>r.u32();
  const partitions = <i32>r.u32();
  const counts = new Map<string, u32>();
  countWords(ownedBytes(start, end, total), counts);

  const words = counts.keys();
  words.sort(byWord);
  const sections = new Array<ByteWriter>(partitions);
  const sizes = new Array<i32>(partitions);
  for (let p = 0; p < partitions; p++) {
    sections[p] = new ByteWriter(64);
    sizes[p] = 0;
  }
  for (let i = 0; i < words.length; i++) {
    const p = partitionOf(words[i], partitions);
    sections[p].str(words[i]).u32(counts.get(words[i]));
    sizes[p] += 1;
  }
  const out = new ByteWriter(64 + words.length * 24);
  out.u32(<u32>partitions);
  let offset = 4 + 8 * partitions;
  for (let p = 0; p < partitions; p++) {
    const length = 4 + sections[p].length;
    out.u32(<u32>offset).u32(<u32>length);
    offset += length;
  }
  for (let p = 0; p < partitions; p++) {
    out.u32(<u32>sizes[p]);
    out.raw(sections[p].toBytes());
  }
  return out.toBytes();
}

/** Parallel arrays the sort comparator reads (closures cannot capture locals). */
let sortWords: string[] = [];
let sortCounts: u32[] = [];

function byCountDesc(a: i32, b: i32): i32 {
  const ca = sortCounts[a];
  const cb = sortCounts[b];
  if (ca != cb) return ca > cb ? -1 : 1;
  return byWord(sortWords[a], sortWords[b]);
}

/** Add `count × (str word, u32 count)` pairs to the map. */
function addPairs(r: ByteReader, counts: Map<string, u32>): void {
  const n = <i32>r.u32();
  for (let i = 0; i < n; i++) {
    const word = r.str();
    const c = r.u32();
    counts.set(word, counts.has(word) ? counts.get(word) + c : c);
  }
}

/** Sorted (word, count) pairs: u32 count | count × (str word, u32 count), by count desc then word. */
function sortedPairs(counts: Map<string, u32>): Uint8Array {
  const order = rankOf(counts);
  const w = new ByteWriter(16 + order.length * 24);
  w.u32(<u32>order.length);
  for (let i = 0; i < order.length; i++) {
    w.str(sortWords[order[i]]).u32(sortCounts[order[i]]);
  }
  return w.toBytes();
}

/** Fill the sort arrays from the map and return indexes by count desc, word asc. */
function rankOf(counts: Map<string, u32>): i32[] {
  sortWords = counts.keys();
  sortCounts = new Array<u32>(sortWords.length);
  const order = new Array<i32>(sortWords.length);
  for (let i = 0; i < sortWords.length; i++) {
    sortCounts[i] = counts.get(sortWords[i]);
    order[i] = i;
  }
  order.sort(byCountDesc);
  return order;
}

function reduceTask(input: Uint8Array): Uint8Array {
  const r = new ByteReader(input);
  const partition = <i32>r.u32();
  const mapCount = <i32>r.u32();
  const files = fs.list("/out/0/");
  if (files.length != mapCount) {
    abort("expected " + mapCount.toString() + " map outputs, found " + files.length.toString());
  }
  const counts = new Map<string, u32>();
  for (let f = 0; f < files.length; f++) {
    const header = fs.readRange(files[f], 0, 4 + 8 * PARTITIONS);
    if (header === null) abort("missing map output " + files[f]);
    const h = new ByteReader(header as Uint8Array);
    const partitions = <i32>h.u32();
    if (partitions != PARTITIONS) abort("map output with " + partitions.toString() + " partitions");
    let offset: i32 = 0;
    let length: i32 = 0;
    for (let p = 0; p < partitions; p++) {
      const off = <i32>h.u32();
      const ln = <i32>h.u32();
      if (p == partition) {
        offset = off;
        length = ln;
      }
    }
    if (length <= 4) continue; // an empty section is just its count
    const section = fs.readRange(files[f], offset, length);
    if (section === null) abort("missing map output " + files[f]);
    addPairs(new ByteReader(section as Uint8Array), counts);
  }
  return sortedPairs(counts);
}

function mergeTask(input: Uint8Array): Uint8Array {
  const r = new ByteReader(input);
  const k = <i32>r.u32();
  const reduceCount = <i32>r.u32();
  const outputs = fs.outputs(1);
  if (outputs.length != reduceCount) {
    abort(
      "expected " + reduceCount.toString() + " reduce outputs, found " + outputs.length.toString(),
    );
  }
  const counts = new Map<string, u32>();
  for (let f = 0; f < outputs.length; f++) addPairs(new ByteReader(outputs[f]), counts);
  const order = rankOf(counts);
  let total: u64 = 0;
  for (let i = 0; i < sortCounts.length; i++) total += <u64>sortCounts[i];
  const top = order.length < k ? order.length : k;
  const b = bars();
  for (let i = 0; i < top; i++) b.bar(sortWords[order[i]], <f64>sortCounts[order[i]]);
  log(
    sortWords.length.toString() +
      " distinct words, " +
      total.toString() +
      " in total; top " +
      top.toString(),
  );
  return b.toBytes();
}
