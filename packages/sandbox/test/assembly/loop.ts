// Fixture: run never returns.
export function alloc(len: i32): usize {
  return heap.alloc(len);
}

export function run(inPtr: usize, inLen: i32): usize {
  let i: i64 = 0;
  while (inLen >= 0) {
    i++;
  }
  return <usize>i;
}

export function plan(inPtr: usize, inLen: i32): usize {
  return run(inPtr, inLen);
}
