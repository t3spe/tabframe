/// <reference lib="webworker" />
// The compiler worker (design §5.6): AssemblyScript's asc, bundled for the browser, loaded only
// when the editor opens. Binaryen arrives as its own asset next to this script. One compile at a
// time; the page waits.

import { COMPILER_VERSION, compileInMemory } from "./compiler.ts";
import type { WorkerReply, WorkerRequest } from "./compiler-types.ts";

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg?.type !== "compile") return;
  const result = await compileInMemory(msg.fs, msg.flags);
  const reply: WorkerReply = { type: "compiled", id: msg.id, ...result };
  scope.postMessage(reply);
};

scope.postMessage({ type: "ready", version: COMPILER_VERSION } satisfies WorkerReply);
