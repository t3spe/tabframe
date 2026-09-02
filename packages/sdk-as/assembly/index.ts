// Tabframe SDK for AssemblyScript programs. A program:
//
//   import { readRunInput, readPlanInput, stage, done, emit } from "@tabframe/sdk-as/assembly/index";
//   export { alloc } from "@tabframe/sdk-as/assembly/index";
//   export function plan(ptr: usize, len: i32): usize { ... return emit(stage("x").task(bytes).toBytes()); }
//   export function run(ptr: usize, len: i32): usize { ... return emit(outputBytes); }
//
// Compile with: -O3 --runtime stub --maximumMemory <pages> [--noAssert] --path <program>/node_modules
// (the program package depends on @tabframe/sdk-as; asc resolves the subpath import through that
// node_modules directory).
// Allowed imports: tf.stat/read/write/list/log and env.abort. Date.now, Math.random (env.seed),
// and anything else are rejected by the sandbox. AssemblyScript's Math is compiled to WASM and is
// deterministic; never write NaN into an output.
export { ABI_VERSION, alloc, done, emit, PlanInput, readPlanInput, readRunInput, RunInput, Stage, stage } from "./abi";
export { Bars, bars } from "./bars";
export { ByteReader, ByteWriter } from "./bytes";
export { fs, log } from "./host";
export { Params, quote, unquote } from "./params";
