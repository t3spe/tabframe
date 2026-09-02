// Fixture: a global that would leak between tasks if instances were reused.
let counter: i32 = 0;

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
  counter++;
  const p = heap.alloc(4);
  store<i32>(p, counter);
  return pair(p, 4);
}

export function plan(inPtr: usize, inLen: i32): usize {
  return run(inPtr, inLen);
}
