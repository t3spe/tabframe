// Fixture: reads the clock, which needs an import the sandbox forbids.
export function alloc(len: i32): usize {
  return heap.alloc(len);
}

function pair(ptr: usize, len: i32): usize {
  const p = heap.alloc(8);
  store<u32>(p, <u32>ptr);
  store<u32>(p + 4, <u32>len);
  return p;
}

export function run(inPtr: usize, inLen: i32): usize {
  const t = Date.now();
  const p = heap.alloc(8);
  store<i64>(p, t);
  return pair(p, 8);
}

export function plan(inPtr: usize, inLen: i32): usize {
  return run(inPtr, inLen);
}
