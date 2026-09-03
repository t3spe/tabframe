// Hello, text: the smallest Tabframe program. One stage with one task; the task returns a line
// of text, and the dashboard's `text` view shows it. Read this first, then the Mandelbrot program
// (tiles, one stage, a follow-up) and word count (three stages over a file).
//
//   plan: called once per stage with the stage number and the params; returns the stage's tasks,
//         or done(next) to end — `next` is a follow-up's params, or null.
//   run:  called once per task with the task's input bytes; returns the output bytes.
//
// Everything a program sees comes in through those bytes and the execution's filesystem: no
// clock, no randomness, no network, and a task may run on any core, twice, or halfway.
import {
  ByteReader,
  ByteWriter,
  done,
  emit,
  readPlanInput,
  readRunInput,
  stage,
} from "@tabframe/sdk-as/assembly/index";

export { alloc } from "@tabframe/sdk-as/assembly/index";

export function plan(ptr: usize, len: i32): usize {
  const input = readPlanInput(ptr, len);
  if (input.stage == 0) {
    // One task; its input carries the greeting's subject from the params (default "world").
    const who = input.params.getString("who", "world");
    const s = stage("say");
    s.task(new ByteWriter().str(who).toBytes());
    return emit(s.toBytes());
  }
  return emit(done(null)); // no follow-up: the execution ends after stage 0
}

export function run(ptr: usize, len: i32): usize {
  const task = readRunInput(ptr, len);
  const who = new ByteReader(task.input).str();
  const text = `hello, ${who} — from task ${task.taskIndex} of ${task.taskCount}`;
  return emit(Uint8Array.wrap(String.UTF8.encode(text)));
}
