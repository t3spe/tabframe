// A test program: echoes what the SDK decoded so the TypeScript side can check both directions of
// every ABI format, exercises the filesystem imports against the sandbox, and reports the SDK's
// return codes. The stage selects the mode — plan: 0 builds a stage from the params, 7 reports
// return codes, 9 copies the params raw, anything else echoes them decoded; run: 8 builds a bars
// payload from its input, anything else echoes the run input.
import {
  bars,
  ByteReader,
  ByteWriter,
  done,
  emit,
  fs,
  log,
  Params,
  RC,
  readPlanInput,
  readRunInput,
  stage,
} from "../../assembly/index";

export { alloc } from "../../assembly/index";

/** run: [u32 stage][u32 taskIndex][u32 taskCount][blob input]; stage 8: `u32 n | n × (str label | f64 value)` → bars. */
export function run(ptr: usize, len: i32): usize {
  const t = readRunInput(ptr, len);
  if (t.stage == 8) {
    const r = new ByteReader(t.input);
    const n = <i32>r.u32();
    const b = bars();
    for (let i = 0; i < n; i++) {
      const label = r.str();
      b.bar(label, r.f64());
    }
    return emit(b.toBytes());
  }
  const w = new ByteWriter();
  w.u32(t.stage).u32(t.taskIndex).u32(t.taskCount).blob(t.input);
  return emit(w.toBytes());
}

/**
 * plan: stage 0 builds a stage from params (name, n tasks, optional canvas, optional placements,
 * each input = [u32 i][f64 scale]); stage 9 returns done with every param copied raw; stage 7
 * returns done with the SDK's return codes and what the raw fs forms return; other stages return
 * done with every param echoed raw plus the decoded scalars under new keys. With params.fs = true
 * the filesystem imports are exercised.
 */
export function plan(ptr: usize, len: i32): usize {
  const input = readPlanInput(ptr, len);
  const p = input.params;

  if (p.getBool("fs", false)) {
    const a = fs.read("/in/a.txt");
    if (a !== null) {
      const bytes = a as Uint8Array;
      const reversed = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) reversed[i] = bytes[bytes.length - 1 - i];
      fs.write("/out/b.txt", reversed);
      const range = fs.readRange("/in/a.txt", 1, 3);
      if (range !== null) fs.write("/out/range.txt", range as Uint8Array);
    }
    const listing = fs.list("/in/");
    log("listing: " + listing.join(","));
    log("stat missing: " + fs.stat("/nope").toString());
    log("hint nodes: " + input.hints.getI32("nodes", -1).toString());
  }

  if (input.stage == 9) {
    const copy = new Params();
    for (let i = 0; i < p.size; i++) copy.set(p.keys[i], p.values[i]);
    return emit(done(copy));
  }

  if (input.stage == 7) {
    const probe = new Uint8Array(4);
    const next = new Params();
    next.setI32("notFound", RC.notFound);
    next.setI32("badArgs", RC.badArgs);
    next.setI32("capExceeded", RC.capExceeded);
    next.setI32("writeRelative", fs.writeRc("relative/x", probe));
    next.setI32("writeOk", fs.writeRc("/out/probe", probe));
    next.setI32("statMissing", <i32>fs.stat("/nope"));
    next.setI32("readMissing", fs.readRc("/nope", 0, probe));
    next.setI32("readBadOffset", fs.readRc("/out/probe", -1, probe));
    next.setI32("readOk", fs.readRc("/out/probe", 1, probe));
    return emit(done(next));
  }

  if (input.stage != 0) {
    const next = new Params();
    for (let i = 0; i < p.size; i++) next.set(p.keys[i], p.values[i]);
    next.setI32("stage", <i32>input.stage);
    next.setString("s", p.getString("s", "?"));
    next.setI32("i", p.getI32("i", -1));
    next.setF64("f", p.getF64("f", -1.0));
    next.setBool("b", p.getBool("b", false));
    next.setString("missing", p.getString("missing", "fallback"));
    next.setI32("bad", p.getI32("bad", 7));
    next.setI32("clamped", p.getI32In("i", 0, -10, 10));
    return emit(done(next));
  }

  const name = p.getString("name", "echo");
  const n = p.getI32("n", 1);
  const scale = p.getF64("scale", 1.5);
  const placed = p.getBool("placed", false);
  const s = stage(name);
  if (p.has("cw")) s.canvas(<u32>p.getI32("cw", 0), <u32>p.getI32("ch", 0));
  for (let i = 0; i < n; i++) {
    const w = new ByteWriter();
    w.u32(<u32>i).f64(scale);
    if (placed) s.taskAt(w.toBytes(), i * 10, -i, 10, 20);
    else s.task(w.toBytes());
  }
  return emit(s.toBytes());
}
