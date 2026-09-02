// Fixture: run echoes its input; plan returns a "done" stage spec (TFSS, version 1, kind 1, no next).
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
  const out = heap.alloc(inLen);
  for (let i = 0; i < inLen; i++) store<u8>(out + i, load<u8>(inPtr + i));
  return pair(out, inLen);
}

export function plan(inPtr: usize, inLen: i32): usize {
  const p = heap.alloc(10);
  store<u32>(p, 0x53534654);
  store<u32>(p + 4, 1);
  store<u8>(p + 8, 1);
  store<u8>(p + 9, 0);
  return pair(p, 10);
}
