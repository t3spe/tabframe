/// <reference lib="webworker" />
// Web adapter, worker side: the dedicated worker a browser node spawns for its sandbox. Bytes come
// from the store with synchronous requests, which dedicated workers are allowed to make
// (design §4.2). Verified in preflight on 2026-09-01.
import type { ResultMessage, TaskMessage } from "../host.ts";
import { runTask } from "../run.ts";
import { type BlobReader, CachingBlobReader } from "../types.ts";

class XhrBlobReader implements BlobReader {
  private readonly base: string;

  constructor(storeBase: string) {
    this.base = storeBase.replace(/\/$/, "");
  }

  read(hash: string, offset: number, len: number): Uint8Array | null {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", `${this.base}/${hash}`, false);
    if (offset !== 0 || Number.isFinite(len)) {
      const end = Number.isFinite(len) ? String(offset + len - 1) : "";
      xhr.setRequestHeader("Range", `bytes=${offset}-${end}`);
    }
    xhr.responseType = "arraybuffer";
    try {
      xhr.send();
    } catch {
      return null;
    }
    if (xhr.status === 200 || xhr.status === 206)
      return new Uint8Array(xhr.response as ArrayBuffer);
    return null;
  }
}

const readers = new Map<string, CachingBlobReader>();
const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (ev: MessageEvent<TaskMessage & { storeBase?: string }>) => {
  const msg = ev.data;
  if (msg?.type !== "task") return;
  const base = msg.storeBase ?? "/blob";
  let reader = readers.get(base);
  if (!reader) {
    reader = new CachingBlobReader(new XhrBlobReader(base));
    readers.set(base, reader);
  }
  const result = runTask(msg.module, { ...msg.request, reader });
  const reply: ResultMessage = { type: "result", id: msg.id, result };
  scope.postMessage(reply);
};
