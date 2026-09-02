// Fixture: mode byte 0 aborts with a message (env.abort), mode 1 traps with unreachable.
export function alloc(len: i32): usize {
  return heap.alloc(len);
}

export function run(inPtr: usize, inLen: i32): usize {
  const mode = inLen > 0 ? load<u8>(inPtr) : 0;
  if (mode == 1) unreachable();
  abort("boom");
  return 0;
}

export function plan(inPtr: usize, inLen: i32): usize {
  return run(inPtr, inLen);
}
