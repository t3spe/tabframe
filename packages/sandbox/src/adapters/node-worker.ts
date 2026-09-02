// Node adapter, worker side: a worker_threads entry that runs tasks and reads blobs through the
// Atomics bridge. Cloud cores and the local dev cores run this (design §4.2, §4.3).
import { parentPort, workerData } from "node:worker_threads";
import type { ResultMessage, TaskMessage } from "../host.ts";
import { runTask } from "../run.ts";
import { CachingBlobReader } from "../types.ts";
import { type BlobRequest, BridgeBlobReader } from "./bridge.ts";

const port = parentPort;
if (!port) throw new Error("node-worker must run as a worker thread");
const { sab } = workerData as { sab: SharedArrayBuffer };
const reader = new CachingBlobReader(
  new BridgeBlobReader(sab, (req: BlobRequest) => port.postMessage(req)),
);

port.on("message", (msg: TaskMessage) => {
  if (msg?.type !== "task") return;
  const result = runTask(msg.module, { ...msg.request, reader });
  const reply: ResultMessage = { type: "result", id: msg.id, result };
  port.postMessage(reply);
});
