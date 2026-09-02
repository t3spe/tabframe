// Fixture: exercises the five tf imports. The first input byte selects a mode.
@external("tf", "stat")
declare function tf_stat(path: usize, pathLen: i32): i64;
@external("tf", "read")
declare function tf_read(path: usize, pathLen: i32, offset: i32, dst: usize, dstLen: i32): i32;
@external("tf", "write")
declare function tf_write(path: usize, pathLen: i32, src: usize, srcLen: i32): i32;
@external("tf", "list")
declare function tf_list(prefix: usize, prefixLen: i32, dst: usize, dstLen: i32): i32;
@external("tf", "log")
declare function tf_log(src: usize, srcLen: i32): void;

export function alloc(len: i32): usize {
  return heap.alloc(len);
}

function pair(ptr: usize, len: i32): usize {
  const p = heap.alloc(8);
  store<u32>(p, <u32>ptr);
  store<u32>(p + 4, <u32>len);
  return p;
}

function bytesOf(s: string): ArrayBuffer {
  return String.UTF8.encode(s);
}

function ptr(b: ArrayBuffer): usize {
  return changetype<usize>(b);
}

function stat(path: string): i64 {
  const b = bytesOf(path);
  return tf_stat(ptr(b), b.byteLength);
}

function readAll(path: string): string | null {
  const size = stat(path);
  if (size < 0) return null;
  const buf = heap.alloc(<usize>size + 1);
  const p = bytesOf(path);
  const n = tf_read(ptr(p), p.byteLength, 0, buf, <i32>size);
  if (n < 0) return null;
  return String.UTF8.decodeUnsafe(buf, <usize>n);
}

function write(path: string, content: string): i32 {
  const p = bytesOf(path);
  const c = bytesOf(content);
  return tf_write(ptr(p), p.byteLength, ptr(c), c.byteLength);
}

function list(prefix: string, cap: i32): string {
  const p = bytesOf(prefix);
  const buf = heap.alloc(cap + 1);
  const n = tf_list(ptr(p), p.byteLength, buf, cap);
  if (n < 0) return "err" + n.toString();
  if (n > cap) return "need" + n.toString();
  return String.UTF8.decodeUnsafe(buf, <usize>n);
}

function log(s: string): void {
  const b = bytesOf(s);
  tf_log(ptr(b), b.byteLength);
}

function out(s: string): usize {
  const b = bytesOf(s);
  return pair(ptr(b), b.byteLength);
}

export function run(inPtr: usize, inLen: i32): usize {
  const mode = inLen > 0 ? load<u8>(inPtr) : 0;
  if (mode == 0) {
    const size = stat("/in/a.txt");
    const data = readAll("/in/a.txt");
    const listing = list("/in/", 4096);
    const rc = write("/out/copy.txt", data === null ? "" : data!);
    log("hello ");
    log("world");
    return out(
      "size=" +
        size.toString() +
        ";list=" +
        listing +
        ";data=" +
        (data === null ? "null" : data!) +
        ";rc=" +
        rc.toString(),
    );
  }
  if (mode == 1) {
    const n = load<i32>(inPtr + 1);
    let rc: i32 = 0;
    for (let i = 0; i < n; i++) {
      rc = write("/out/f" + i.toString(), "x");
      if (rc != 0) break;
    }
    return out("rc=" + rc.toString());
  }
  if (mode == 2) {
    const m = load<i32>(inPtr + 1);
    const buf = heap.alloc(m);
    const p = bytesOf("/out/big");
    const rc = tf_write(ptr(p), p.byteLength, buf, m);
    return out("rc=" + rc.toString());
  }
  if (mode == 3) {
    const k = load<i32>(inPtr + 1);
    for (let i = 0; i < k; i++) log("0123456789");
    return out("ok");
  }
  if (mode == 4) {
    const s = stat("/nope");
    const buf = heap.alloc(16);
    const p = bytesOf("/nope");
    const r = tf_read(ptr(p), p.byteLength, 0, buf, 16);
    return out("stat=" + s.toString() + ";read=" + r.toString());
  }
  if (mode == 5) {
    return out("rc=" + write("relative/x", "y").toString());
  }
  if (mode == 6) {
    return out(list("/in/", 4) + "|" + list("/in/", 4096));
  }
  if (mode == 7) {
    const p = bytesOf("/in/a.txt");
    const buf = heap.alloc(4);
    const n = tf_read(ptr(p), p.byteLength, 2, buf, 3);
    return out("n=" + n.toString() + ";" + String.UTF8.decodeUnsafe(buf, <usize>(n > 0 ? n : 0)));
  }
  if (mode == 8) {
    write("/out/own.txt", "mine");
    const d = readAll("/out/own.txt");
    return out(
      "own=" +
        (d === null ? "null" : d!) +
        ";stat=" +
        stat("/out/own.txt").toString() +
        ";list=" +
        list("/out/", 4096),
    );
  }
  if (mode == 9) {
    const p = bytesOf("/in/a.txt");
    const r = tf_read(ptr(p), p.byteLength, -1, heap.alloc(4), 4);
    return out("rc=" + r.toString());
  }
  return out("mode?");
}

export function plan(inPtr: usize, inLen: i32): usize {
  return run(inPtr, inLen);
}
