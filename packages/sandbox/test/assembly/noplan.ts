// Fixture: a module without the plan export.
export function alloc(len: i32): usize {
  return heap.alloc(len);
}

export function run(inPtr: usize, inLen: i32): usize {
  return 0;
}
